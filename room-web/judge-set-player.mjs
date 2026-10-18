// One twelve-second clock drives both media. Network selection is prepared
// ahead of the boundary; the already decoded standby keeps the clock running.
export function createSetPlayer({
  context,
  destination = context.destination,
  choose,
  fallback,
  onStart = () => {},
  onAbandon = () => {},
  setTimer = setInterval,
  clearTimer = clearInterval,
  audioEnabled = true,
}) {
  let starting = false,
    running = false,
    revision = 0,
    timer,
    nextAt = 0,
    choosing = false,
    pendingAt = null,
    current = null,
    ready = 0;
  const sources = new Set(),
    scheduled = [],
    history = [];
  function schedule(set, at) {
    if (!set || audioEnabled && !set.buffer) return false;
    if (audioEnabled) {
    const source = context.createBufferSource(),
      gain = context.createGain();
    source.buffer = set.buffer;
    source.connect(gain);
    gain.connect(destination);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.7, at + 0.005);
    gain.gain.setValueAtTime(0.7, at + 11.985);
    gain.gain.linearRampToValueAtTime(0, at + 12);
    source.start(at, 0, 12);
    source.stop(at + 12);
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
      gain.disconnect();
    };
    }
    scheduled.push({ id: set.id, start: at, end: at + 12, set });
    if (scheduled.length > 100) scheduled.shift();
    nextAt = at + 12;
    return true;
  }
  function tick() {
    if (!running) return;
    const now = context.currentTime;
    const active = scheduled.findLast((s) => s.start <= now && s.end > now);
    if (active && active !== current) {
      current = active;
      history.push({ id: active.id, at: active.start, kind: active.set.kind });
      if (history.length > 200) history.shift();
      void onStart(active.set, active.start, Math.max(0, now - active.start));
    }
    if (nextAt - now < 2 && !choosing && pendingAt !== nextAt) {
      choosing = true;
      const generation = revision,
        target = nextAt;
      pendingAt = target;
      Promise.resolve(choose())
        .then((set) => {
          if (!running || generation !== revision || nextAt !== target) {
            if (set) void onAbandon(set);
            return;
          }
          if (set) schedule(set, Math.max(target, context.currentTime + 0.02));
        })
        .catch(() => {})
        .finally(() => {
          choosing = false;
        });
    }
    if (nextAt - now < 0.08) {
      const standby = fallback();
      if (standby) schedule(standby, Math.max(nextAt, now + 0.02));
    }
  }
  return {
    setReady(count) {
      ready = count;
    },
    async start() {
      if (running || starting) return;
      starting = true;
      const generation = ++revision;
      try {
        await context.resume();
        const set = await choose();
        if (generation !== revision) {
          if (set) void onAbandon(set);
          return;
        }
        if (!set) throw Error("PLAYBACK_NOT_READY");
        running = true;
        current = null;
        schedule(set, context.currentTime + 0.1);
        timer = setTimer(tick, 25);
      } finally {
        starting = false;
      }
    },
    stop() {
      running = false;
      revision++;
      clearTimer(timer);
      for (const s of sources) {
        try {
          s.stop();
        } catch {}
      }
      sources.clear();
      scheduled.length = 0;
      current = null;
      nextAt = 0;
      pendingAt = null;
      choosing = false;
    },
    read() {
      return {
        running,
        revision,
        contextState: context.state,
        audioTime: context.currentTime,
        currentId: current?.id,
        ready,
        scheduled: scheduled.map(({ id, start, end }) => ({ id, start, end })),
        history: [...history],
      };
    },
    tick,
  };
}
