import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerifiedWaveDerivationCache} from '../integration/runtime/verified-wave-derivation.mjs';
import {contextWave, decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {syntheticWave, fixtureSha} from './cloud-worker-fixture.mjs';

const input = bytes => ({bytes, sha256: fixtureSha(bytes), byteLength: bytes.length});
function floatWave() {
  const original = decodeCompleteWave(syntheticWave(24)), bytes = Buffer.alloc(44 + original.pcm.length * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(44100 * 8, 28); bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(original.pcm.length * 4, 40);
  for (let index = 0; index < original.pcm.length; index++) bytes.writeFloatLE(original.pcm[index], 44 + index * 4);
  return bytes;
}
test('cold and hot pure derivations equal unchanged complete-WAV/context math for int16 and float32 source bytes', () => {
  const cache = createVerifiedWaveDerivationCache();
  for (const bytes of [syntheticWave(24), floatWave()]) {
    const raw = decodeCompleteWave(bytes), expected = contextWave(raw), cold = cache.derive(input(bytes)), hot = cache.derive(input(bytes));
    assert.equal(cold.frames, raw.frames); assert.equal(cold.rate, raw.rate); assert.equal(cold.sha256, raw.sha256);
    assert.equal(hot.contextSha256, fixtureSha(expected)); assert.deepEqual(hot.contextBytes, expected);
    assert.deepEqual(cold.copyPcm(), raw.pcm); assert.deepEqual(hot.copyPcm(), raw.pcm);
    assert.equal(Object.isFrozen(hot), true);
  }
  assert.deepEqual(cache.readUsage(), {entries: 2, retainedBytes: 2 * (24 * 44100 * 2 * 4 + 44 + 16 * 44100 * 4), hits: 2, misses: 2});
});
test('every hot lookup validates new physical SHA and exact length rather than caller metadata or asset identity', () => {
  const cache = createVerifiedWaveDerivationCache(), bytes = syntheticWave(24), reference = input(bytes);
  cache.derive(reference); const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.throws(() => cache.derive({...reference, bytes: changed, actual: true, qcPassed: true}), /PHYSICAL_BYTES_REQUIRED/);
  assert.throws(() => cache.derive({...reference, byteLength: bytes.length - 1}), /PHYSICAL_BYTES_REQUIRED/);
  assert.throws(() => cache.derive({...reference, bytes: bytes.subarray(0, bytes.length - 1)}), /PHYSICAL_BYTES_REQUIRED/);
  assert.equal(cache.readUsage().hits, 0);
  const fresh = cache.derive(input(changed)); assert.notEqual(fresh.sha256, reference.sha256); assert.equal(cache.readUsage().misses, 2);
  assert.equal('actual' in fresh, false); assert.equal('qcPassed' in fresh, false);
});
test('returned PCM/context buffers are independent copies and cannot corrupt cached derivation or later callers', () => {
  const cache = createVerifiedWaveDerivationCache(), bytes = syntheticWave(24), first = cache.derive(input(bytes));
  const context = Buffer.from(first.contextBytes), pcm = first.copyPcm(); pcm.fill(1); first.contextBytes.fill(0);
  const next = cache.derive(input(bytes)); assert.deepEqual(next.contextBytes, context);
  assert.notEqual(next.copyPcm()[0], 1); assert.notEqual(first.copyPcm()[0], 1);
  next.contextBytes[50] ^= 1; assert.deepEqual(cache.derive(input(bytes)).contextBytes, context);
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => cache.derive({bytes, sha256: first.sha256, byteLength: bytes.length}), /PHYSICAL_BYTES_REQUIRED/);
});
test('partial, malformed, nonfinite and short WAVs are never retained even with accurate physical hashes', () => {
  const cache = createVerifiedWaveDerivationCache(), complete = syntheticWave(24), malformed = Buffer.from(complete), nonfinite = floatWave();
  malformed.write('FAIL', 8); nonfinite.writeFloatLE(NaN, 44);
  for (const bytes of [complete.subarray(0, complete.length - 1), malformed, nonfinite, syntheticWave(5)]) {
    assert.throws(() => cache.derive(input(bytes))); assert.equal(cache.readUsage().entries, 0); assert.equal(cache.readUsage().retainedBytes, 0);
  }
});
test('cache keeps at most two LRU entries and32MiB; oversize decoded content is calculated without being retained', () => {
  const cache = createVerifiedWaveDerivationCache(), a = syntheticWave(24), b = Buffer.from(a), c = Buffer.from(a);
  b[b.length - 2] ^= 1; c[c.length - 2] ^= 2;
  for (const bytes of [a, b, a, c, a, b]) cache.derive(input(bytes));
  assert.equal(cache.readUsage().entries, 2); assert.equal(cache.readUsage().hits, 2); assert.equal(cache.readUsage().misses, 4);
  assert(cache.readUsage().retainedBytes <= 32 * 1024 * 1024);
  const oversized = syntheticWave(90), before = cache.readUsage(); cache.derive(input(oversized)); cache.derive(input(oversized));
  assert.equal(cache.readUsage().entries, before.entries); assert.equal(cache.readUsage().retainedBytes, before.retainedBytes);
  assert.equal(cache.readUsage().hits, before.hits); assert.equal(cache.readUsage().misses, before.misses + 2);
  cache.clear(); assert.deepEqual(cache.readUsage(), {entries: 0, retainedBytes: 0, hits: 0, misses: 0});
});
