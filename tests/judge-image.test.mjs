import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReferenceImage} from '../room-web/judge-image.mjs';

const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const jpeg = Uint8Array.of(255, 216, 255, 224);
const webp = new Uint8Array([82, 73, 70, 70, 20, 0, 0, 0, 87, 69, 66, 80]);
const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0,
  ...new TextEncoder().encode('mif1heic')]);

// Browser decoders and canvas are unavailable in Node. Keep admission,
// normalisation, hashing and resource cleanup in the real implementation.
function browser(t, {width = 4032, height = 3024, outputSize = 16, nullBlob = false} = {}) {
  const created = [], revoked = [], decoded = [], drawn = [];
  let closed = 0;
  const bitmap = {width, height, close() { closed++; }};
  t.mock.method(URL, 'createObjectURL', (blob) => {
    const url = `blob:synthetic-${created.length}`;
    created.push({url, blob});
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  const originals = new Map(['document', 'createImageBitmap'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.createImageBitmap = async file => { decoded.push(file); return bitmap; };
  globalThis.document = {createElement(name) {
    assert.equal(name, 'canvas');
    return {
      getContext: () => ({drawImage: (image, x, y, w, h) => drawn.push({image, w, h})}),
      toBlob: (callback, type) => callback(nullBlob ? null : new Blob([new Uint8Array(outputSize)], {type})),
    };
  }};
  return {created, revoked, decoded, drawn, closed: () => closed};
}

for (const [name, bytes, type] of [
  ['PNG', png, 'image/png'], ['JPEG', jpeg, 'image/jpeg'], ['WebP', webp, 'image/webp'],
]) {
  test(`normalises supported ${name} selection into a bounded PNG and hash`, async t => {
    const env = browser(t);
    const result = await prepareReferenceImage(new File([bytes], 'synthetic', {type}));
    assert.equal(result.blob.type, 'image/png');
    assert.equal(result.hash, '374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb');
    assert.deepEqual([env.drawn[0].w, env.drawn[0].h], [1024, 768]);
    assert.equal(result.previewUrl, env.created.at(-1).url);
    assert.ok(!env.revoked.includes(result.previewUrl));
    assert.equal(env.closed(), 1);
  });
}

test('keeps supported smaller photos at their original size', async t => {
  const env = browser(t, {width: 640, height: 480});
  await prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'}));
  assert.deepEqual([env.drawn[0].w, env.drawn[0].h], [640, 480]);
  assert.equal(env.closed(), 1);
});

for (const [name, bytes, type] of [
  ['HEIC', heic, 'image/heic'], ['HEIF', heic, 'image/heif'],
  ['missing MIME', png, ''], ['generic MIME', jpeg, 'application/octet-stream'],
]) {
  test(`rejects ${name} locally before decoding or producing an uploadable image`, async t => {
    const env = browser(t);
    await assert.rejects(prepareReferenceImage(new File([bytes], 'synthetic.heic', {type})),
      /IMAGE_FORMAT_INVALID/);
    assert.equal(env.decoded.length, 0);
    assert.equal(env.drawn.length, 0);
    assert.equal(env.created.length, 0);
  });
}

test('accepts the 20 megapixel boundary and normalises it before upload', async t => {
  const env = browser(t, {width: 5000, height: 4000});
  await prepareReferenceImage(new File([jpeg], 'synthetic.jpg', {type: 'image/jpeg'}));
  assert.deepEqual([env.drawn[0].w, env.drawn[0].h], [1024, 819]);
  assert.equal(env.closed(), 1);
});

for (const [width, height] of [[5001, 4000], [5712, 4284], [8064, 6048], [31, 100], [100, 31]]) {
  test(`rejects ${width}x${height} before creating a canvas or uploadable image`, async t => {
    const env = browser(t, {width, height});
    await assert.rejects(prepareReferenceImage(new File([jpeg], 'synthetic.jpg', {type: 'image/jpeg'})),
      /IMAGE_FORMAT_INVALID/);
    assert.equal(env.drawn.length, 0);
    assert.equal(env.created.length, 0);
    assert.equal(env.closed(), 1);
  });
}

test('accepts the 8 MiB input boundary and rejects larger input before decoding', async t => {
  const env = browser(t);
  const limit = 8 * 1024 * 1024;
  const exact = new File([png, new Uint8Array(limit - png.length)], 'synthetic.png', {type: 'image/png'});
  await prepareReferenceImage(exact);
  assert.equal(env.decoded.length, 1);
  assert.equal(env.closed(), 1);
  await assert.rejects(prepareReferenceImage(new File([exact, new Uint8Array(1)], 'synthetic.png',
    {type: 'image/png'})), /IMAGE_TOO_LARGE/);
  assert.equal(env.decoded.length, 1);
  assert.equal(env.created.length, 1);
});

test('accepts a normalised PNG at the 2 MiB server limit', async t => {
  const env = browser(t, {outputSize: 2 * 1024 * 1024});
  const result = await prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'}));
  assert.equal(result.blob.size, 2 * 1024 * 1024);
  assert.equal(env.closed(), 1);
});

test('rejects a normalised PNG above the server limit without retaining a preview', async t => {
  const env = browser(t, {outputSize: 2 * 1024 * 1024 + 1});
  await assert.rejects(prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'})),
    /IMAGE_TOO_LARGE/);
  assert.equal(env.closed(), 1);
  assert.equal(env.created.length, 0);
});

test('releases the decoded source if the browser cannot encode a PNG', async t => {
  const env = browser(t, {nullBlob: true});
  await assert.rejects(prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'})));
  assert.equal(env.closed(), 1);
  assert.equal(env.created.length, 0);
});
