import {currentDisplaySet, displayChannel, videoDescriptor} from './judge-display.mjs';
import {paintVjFrame, trackHue} from './judge-vj.mjs';

// Muted video only: the owner remains the sole audio and queue authority.
export function createDisplayPlayer({id, videos, canvas, onCredit}) {
  if (!id) return () => {};
  const channel = new BroadcastChannel(displayChannel(id));
  const graphics = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const nodes = new Map();
  let snapshot, active, requestAt = 0, frameId, disposed = false, width = 1, height = 1, credit = '';
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 1.5, 1920 / Math.max(1, rect.width), 1080 / Math.max(1, rect.height));
    width = canvas.width = Math.max(1, Math.round(rect.width * ratio));
    height = canvas.height = Math.max(1, Math.round(rect.height * ratio));
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  const setCredit = value => { if (credit !== value) { credit = value; onCredit(value); } };
  channel.onmessage = ({data}) => {
    if (data?.type !== 'frame' || !Number.isFinite(data.audioTime) || !Number.isFinite(data.sentAt)) return;
    snapshot = data;
    const wanted = new Set();
    for (const item of [...(data.scheduled ?? []), ...(data.preload ?? [])].slice(0, 10)) {
      if (!videoDescriptor(item, item.src, location.origin)) continue;
      wanted.add(item.id);
      if (nodes.has(item.id)) continue;
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.loop = true; video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true'); video.src = item.src;
      videos.append(video); nodes.set(item.id, video); video.load();
    }
    for (const [key, video] of nodes) {
      if (wanted.has(key) || key === active) continue;
      video.pause(); video.removeAttribute('src'); video.load(); video.remove(); nodes.delete(key);
    }
  };
  function draw() {
    if (disposed) return;
    const now = Date.now();
    // The visible display drives sampling even when the owner tab's rAF is asleep.
    if (now - requestAt >= 80) { requestAt = now; channel.postMessage({type: 'frame-request'}); }
    const set = currentDisplaySet(snapshot, now);
    const video = set && nodes.get(set.id);
    if (video && video.readyState >= 2) {
      if (active !== set.id) {
        active = set.id;
        for (const [key, node] of nodes) {
          node.classList.toggle('active', key === active);
          if (key !== active) node.pause();
        }
        video.currentTime = Math.min(set.offset, video.duration - .01);
        setCredit(set.credit);
      }
      if (Math.abs(video.currentTime - set.offset) > .3) video.currentTime = Math.min(set.offset, video.duration - .01);
      if (video.paused) void video.play().catch(() => {});
      if (graphics && snapshot.visual) paintVjFrame(graphics, videos, width, height,
        {signal: snapshot.visual.signal, age: set.offset, hue: trackHue(set.id)}, motion.matches);
    } else if (!set) {
      for (const node of nodes.values()) node.pause();
      graphics?.clearRect(0, 0, width, height);
      videos.style.transform = '';
    }
    frameId = requestAnimationFrame(draw);
  }
  draw();
  return () => {
    disposed = true; cancelAnimationFrame(frameId); observer.disconnect(); channel.close();
    for (const video of nodes.values()) { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
    graphics?.clearRect(0, 0, width, height);
  };
}
