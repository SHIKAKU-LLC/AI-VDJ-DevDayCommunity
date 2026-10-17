import {createHash} from 'node:crypto';
import {contextWave, decodeCompleteWave} from './bootstrap.mjs';

const VERSION = 'complete-wave-context-v1', MAX_ENTRIES = 2, MAX_BYTES = 32 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Error('VERIFIED_WAVE_PHYSICAL_BYTES_REQUIRED'); };

// Pure, content-addressed arithmetic only. Every lookup copies and hashes fresh
// caller bytes; nothing here can establish a private save, QC or playback fact.
// Do not add source/room/permission/profile/observation data to these entries.
export function createVerifiedWaveDerivationCache() {
  const entries = new Map(); let retainedBytes = 0, hits = 0, misses = 0;
  function derive({bytes, sha256, byteLength} = {}) {
    if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_BYTES ||
        bytes.byteLength !== byteLength || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail();
    // Copy first, including SharedArrayBuffer-backed views, so external mutation
    // cannot replace content between its digest and deterministic derivation.
    const physical = Buffer.from(bytes);
    if (sha(physical) !== sha256) fail();
    const key = VERSION + ':' + sha256 + ':' + byteLength;
    let entry = entries.get(key);
    if (entry) { hits++; entries.delete(key); entries.set(key, entry); }
    else {
      misses++;
      const audio = decodeCompleteWave(physical), contextBytes = contextWave(audio);
      entry = {pcm: audio.pcm, frames: audio.frames, rate: audio.rate, durationSeconds: audio.durationSeconds,
        sha256: audio.sha256, contextBytes, contextSha256: sha(contextBytes), weight: audio.pcm.byteLength + contextBytes.byteLength};
      if (entry.weight <= MAX_BYTES) {
        while (entries.size >= MAX_ENTRIES || retainedBytes + entry.weight > MAX_BYTES) {
          const oldest = entries.keys().next().value, removed = entries.get(oldest);
          entries.delete(oldest); retainedBytes -= removed.weight;
        }
        entries.set(key, entry); retainedBytes += entry.weight;
      }
    }
    // Context bytes are copied eagerly; full PCM is copied only when requested
    // by source-start prefix math. Internal buffers are never returned.
    return Object.freeze({frames: entry.frames, rate: entry.rate, durationSeconds: entry.durationSeconds, sha256: entry.sha256,
      contextSha256: entry.contextSha256, contextBytes: Buffer.from(entry.contextBytes), copyPcm: () => new Float32Array(entry.pcm)});
  }
  return Object.freeze({derive, readUsage: () => Object.freeze({entries: entries.size, retainedBytes, hits, misses}),
    clear() { entries.clear(); retainedBytes = 0; hits = 0; misses = 0; }});
}

const shared = createVerifiedWaveDerivationCache();
export const deriveVerifiedWave = input => shared.derive(input);
