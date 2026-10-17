// Background join preparation. A reservation never renders a join inside the
// finite current Cue: production 2026-10-17 spent ~29s on one A -> B join
// inside the B reservation, longer than A's 24s. Every READY Cue's join from
// each Cue that may sound before it is rendered ahead, one at a time.
// Prepared joins are immutable private media; they grant no selection,
// reservation or credit. Reservations still bind them to the live CURRENT.
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';

const PARENT_ORDER = ['PLAYING', 'SELECTED', 'READY'];
// Replay/recovery can publish a newer operation under a cueId seen before.
// Cache by operation and immutable content, never by cueId alone; status and
// playbackRevision are runtime fields that change on reserve/ACK/Stop.
const identity = cue => { const {status, playbackRevision, ...content} = cue ?? {};
  return String(cue?.cueId) + '@' + String(cue?.operationId ?? '') + '#' + cueDigest(content); };
const label = value => String(value ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'cue';
const reasonCode = error => [error?.code, error?.message]
  .find(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value)) ?? 'PAIR_PREPARATION_FAILED';

export function createPairPreparation({enabled = false, readCues, prepareSource, preverifySource, preparePair,
  runBackground = callback => callback(), onDiagnostic = () => {}, now = Date.now, maxAttempts = 2, cooldownMs = 60000} = {}) {
  if (![readCues, prepareSource, preverifySource, preparePair, runBackground, onDiagnostic, now].every(f => typeof f === 'function') ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(cooldownMs) || cooldownMs < 0)
    throw Error('PAIR_PREPARATION_PORTS_REQUIRED');
  // A settled join is prepared or QC-rejected (null). A join that threw is
  // retried: after maxAttempts failures it waits cooldownMs, then the next
  // sweep (publication, preload or reservation) tries again, so a temporary
  // native/database/storage outage cannot leave a Cue in HOLD for good.
  const settled = new Set(), attempts = new Map(), retryAfter = new Map(), sources = new Map(), preverified = new Set();
  // One in-flight native render per join, shared by the sweep and the preload,
  // so a ~70s render is never started twice for the same pair.
  const inflight = new Map(), outcomes = new Map();
  const keyOf = (parent, candidate) => identity(parent) + '>' + identity(candidate);
  function shared(key, run) {
    if (inflight.has(key)) return inflight.get(key);
    const work = Promise.resolve().then(run);
    inflight.set(key, work);
    work.then(asset => { settled.add(key); outcomes.set(key, asset ?? null); attempts.delete(key); retryAfter.delete(key); }, () => {})
      .finally(() => { if (inflight.get(key) === work) inflight.delete(key); });
    return work;
  }
  let closed = false, running = null, again = false;
  const diagnostic = value => { try { onDiagnostic(value); } catch {} };
  // One actual:false source snapshot per parent Cue, verified once so its own
  // turn as CURRENT needs only live reads inside its finite window.
  async function source(parent) {
    const id = identity(parent);
    if (!sources.has(id)) sources.set(id, await prepareSource(parent));
    const value = sources.get(id);
    if (!preverified.has(id)) { await preverifySource(parent, value); preverified.add(id); }
    return value;
  }
  async function sweep() {
    do {
      again = false;
      const cues = await readCues(), candidates = cues.filter(c => c.status === 'READY');
      // Joins from the sounding Cue are needed first.
      const parents = PARENT_ORDER.flatMap(status => cues.filter(c => c.status === status));
      for (const parent of parents) for (const candidate of candidates) {
        if (closed) return;
        const key = keyOf(parent, candidate), pair = label(parent.cueId) + '>' + label(candidate.cueId);
        // A replayed operation reusing a cueId still needs its join; only the
        // identical operation/content is skipped.
        if (identity(parent) === identity(candidate) || settled.has(key) || (retryAfter.get(key) ?? 0) > now()) continue;
        // The preload may be rendering this join now: wait for it instead.
        if (inflight.has(key)) { await inflight.get(key).catch(() => {}); continue; }
        const started = now();
        try {
          const prepared = await source(parent);
          if (settled.has(key)) continue;
          const asset = await shared(key, () => preparePair({parent, candidate, source: prepared}));
          diagnostic({event: asset ? 'PLAYBACK_PAIR_PREPARED' : 'PLAYBACK_PAIR_REJECTED', reason: pair + ':' + (now() - started) + 'ms'});
        } catch (error) {
          const count = (attempts.get(key) ?? 0) + 1; attempts.set(key, count);
          if (count >= maxAttempts) { attempts.delete(key); retryAfter.set(key, now() + cooldownMs); }
          diagnostic({event: 'PLAYBACK_PAIR_HOLD', reason: pair + ':' + reasonCode(error)});
        }
      }
    } while (again && !closed);
  }
  return Object.freeze({
    // Requests during a sweep coalesce into exactly one more pass.
    schedule() {
      if (!enabled || closed) return;
      if (running) { again = true; return; }
      running = new Promise(resolve => runBackground(() => sweep()
        .catch(error => diagnostic({event: 'PLAYBACK_PAIR_HOLD', reason: 'sweep:' + reasonCode(error)}))
        .finally(() => { running = null; resolve(); })));
    },
    // The preload renders through the same per-join slot: an in-flight sweep
    // render is awaited, and a settled join (prepared or QC-rejected) is not
    // rendered again by either path while a show starts.
    prepareOnce(parent, candidate, run) {
      if (typeof run !== 'function' || !parent?.cueId || !candidate?.cueId) return Promise.reject(Error('PAIR_PREPARATION_PORTS_REQUIRED'));
      const key = keyOf(parent, candidate);
      // A join the sweep already settled (prepared or a final QC rejection)
      // returns its recorded outcome instead of another native render.
      if (outcomes.has(key)) return Promise.resolve(outcomes.get(key));
      return shared(key, run);
    },
    settle(parent, candidate) { if (parent?.cueId && candidate?.cueId) settled.add(keyOf(parent, candidate)); },
    idle: () => running ?? Promise.resolve(),
    close() { closed = true; }});
}
