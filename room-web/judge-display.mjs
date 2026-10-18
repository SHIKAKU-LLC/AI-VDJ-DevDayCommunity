// A display receives only local, decoded video URLs and presentation data.
// It never receives room credentials, API URLs, audio or playback commands.
export const DISPLAY_SESSION = 'vdj-display-session';
const uuid = /^[a-f0-9-]{36}$/;
export const displayChannel = id => `vdj-display:${id}`;
export function readDisplayRoute(location, storage, history) {
  if (!location.hash.startsWith('#display')) return null;
  const candidate = location.hash.startsWith('#display=')
    ? location.hash.slice(9) : storage.getItem(DISPLAY_SESSION);
  const id = uuid.test(candidate ?? '') ? candidate : '';
  if (id) storage.setItem(DISPLAY_SESSION, id);
  history.replaceState(null, '', location.pathname + '#display');
  return {id};
}
export function videoDescriptor(set, src, origin) {
  if (!set || typeof src !== 'string' || !src.startsWith(`blob:${origin}/`)) return null;
  return {id: String(set.id), src, credit: set.kind === 'preset' ? 'AI VDJ プリセット' : String(set.nickname ?? '')};
}
export function displaySchedule(playback, describe) {
  return (playback?.scheduled ?? []).filter(({end}) => end > playback.audioTime).slice(0, 3)
    .flatMap(({id, start, end}) => {
      const item = describe(id);
      return item ? [{...item, start, end}] : [];
    });
}
export function createDisplayHost({snapshot, onConnected = () => {}, open = (...args) => window.open(...args)}) {
  const id = crypto.randomUUID();
  let channel, connectionTimer;
  return {
    open() {
      channel ??= new BroadcastChannel(displayChannel(id));
      channel.onmessage = ({data}) => {
        if (data?.type !== 'frame-request') return;
        onConnected(true);
        clearTimeout(connectionTimer);
        connectionTimer = setTimeout(() => onConnected(false), 2500);
        channel.postMessage({type: 'frame', ...snapshot(), sentAt: Date.now()});
      };
      // noopener also prevents cloning the owner's credential-bearing sessionStorage.
      open(`${location.origin}/room#display=${id}`, '_blank', 'noopener,noreferrer');
    },
    close() { clearTimeout(connectionTimer); channel?.close(); channel = undefined; onConnected(false); },
  };
}

export function currentDisplaySet(frame, now = Date.now()) {
  if (!frame?.running || now - frame.sentAt > 2500) return null;
  const time = frame.audioTime + Math.max(0, now - frame.sentAt) / 1000;
  const set = frame.scheduled?.findLast(s => s.start <= time && s.end > time);
  return set ? {...set, offset: Math.max(0, time - set.start)} : null;
}
