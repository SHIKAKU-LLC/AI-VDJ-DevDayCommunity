// The visual playlist has its own clock; scene changes never restart music.
export function createScenePlayer({clock, onChange, onPrepare = async () => {}, onStop = () => {}, setTimer = setInterval, clearTimer = clearInterval}) {
  const scenes = [], seen = new Set(), failed = new Set(), history = [];
  let running = false, current, preferred, nextAt = 0, timer, switching = false, revision = 0;
  function pick() {
    const candidates = scenes.filter(s => s.id !== current?.id && !failed.has(s.id));
    const fresh = candidates.filter(s => !seen.has(s.id));
    if (!fresh.length && candidates.length) { seen.clear(); if (current) seen.add(current.id); }
    const available = fresh.length ? fresh : candidates;
    return available.find(s => s.trackId === preferred) ?? available[0];
  }
  async function tick() {
    const next = pick(); if (!next) return;
    // Preload only the next candidate. A large stock library must not create
    // dozens of simultaneous full-HD decoders or download every clip at once.
    void onPrepare(next).catch(() => {});
    if (!running || switching || current && clock() < nextAt) return;
    switching = true; const generation = revision, previous = current;
    try {
      await onChange(next, previous, () => running && generation === revision);
      if (!running || generation !== revision) return;
      current = next; seen.add(next.id);
      nextAt = clock() + Math.max(1, next.duration - .75);
      history.push({id: next.id, trackId: next.trackId, at: clock()});
      if (history.length > 200) history.shift();
    } catch { failed.add(next.id); }
    finally { switching = false; }
  }
  return {
    add(scene) { if (!scenes.some(s => s.id === scene.id) && Number.isFinite(scene.duration) && scene.duration >= 2) { scenes.push(scene); void tick(); } },
    setTrack(id) { preferred = id; },
    start() { if (!running) { running = true; revision++; current = undefined; nextAt = 0; timer = setTimer(() => void tick(), 100); void tick(); } },
    stop() { running = false; revision++; clearTimer(timer); current = undefined; onStop(); },
    read: () => ({running, ready: scenes.length, currentId: current?.id, nextAt, failed: failed.size, history: [...history]}),
    tick,
  };
}
