import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReferenceImage} from '../room-web/judge-image.mjs';

const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const jpeg = Uint8Array.of(255, 216, 255, 224);
const webp = new Uint8Array([82, 73, 70, 70, 20, 0, 0, 0, 87, 69, 66, 80]);
const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0,
  ...new TextEncoder().encode('mif1heic')]);

// Synthetic decoders exercise selection/normalisation without personal images or APIs.
function browser(t, {width = 4032, height = 3024, bitmapFails = false,
  bitmapMissing = false, imageFails = false, outputSize = 16, nullBlob = false} = {}) {
  const created = [], revoked = [], drawn = [];
  let closed = 0, imageLoads = 0;
  const bitmap = {width, height, close() { closed++; }};
  t.mock.method(URL, 'createObjectURL', (blob) => {
    const url = `blob:synthetic-${created.length}`;
    created.push({url, blob});
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  const originals = new Map(['document', 'Image', 'createImageBitmap'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.createImageBitmap = bitmapMissing ? undefined : async () => {
    if (bitmapFails) throw new DOMException('Synthetic decode failure', 'InvalidStateError');
    return bitmap;
  };
  globalThis.Image = class {
    naturalWidth = width;
    naturalHeight = height;
    set src(value) {
      if (!value) return;
      imageLoads++;
      queueMicrotask(() => imageFails ? this.onerror?.() : this.onload?.());
    }
  };
  globalThis.document = {createElement(name) {
    assert.equal(name, 'canvas');
    return {
      getContext: () => ({drawImage: (image, x, y, w, h) => drawn.push({image, w, h})}),
      toBlob: (callback, type) => callback(nullBlob ? null : new Blob([new Uint8Array(outputSize)], {type})),
    };
  }};
  return {created, revoked, drawn, closed: () => closed, imageLoads: () => imageLoads};
}

for (const [name, bytes, type, filename] of [
  ['PNG', png, 'image/png', 'synthetic.PNG'], ['JPEG', jpeg, 'image/jpeg', 'synthetic.jpeg'], ['WebP', webp, 'image/webp', 'synthetic.webp'],
  ['missing MIME', png, '', 'synthetic.png'], ['generic MIME', jpeg, 'application/octet-stream', 'synthetic.jpg'],
  ['HEIC', heic, 'image/heic', 'synthetic.HEIC'], ['HEIF without MIME', heic, '', 'synthetic.heif'],
]) {
  test(`normalises ${name} selection into a bounded PNG and hash`, async t => {
    const env = browser(t);
    const result = await prepareReferenceImage(new File([bytes], filename, {type}));
    assert.equal(result.blob.type, 'image/png');
    assert.equal(result.sourceFormat, filename.endsWith('jpeg') || filename.endsWith('jpg') ? 'image/jpeg' : filename.toLowerCase().endsWith('heic') || filename.endsWith('heif') ? 'image/heic' : filename.endsWith('webp') ? 'image/webp' : 'image/png');
    assert.equal(result.hash.length, 64);
    assert.equal(env.drawn[0].w, 1024);
    assert.equal(env.drawn[0].h, 768);
    assert.equal(result.previewUrl, env.created.at(-1).url);
    assert.ok(!env.revoked.includes(result.previewUrl));
    assert.equal(env.closed(), 1);
  });
}

for (const [width, height] of [[5712, 4284], [8064, 6048]]) {
  test(`resizes ${width}x${height} phone photos instead of rejecting their format`, async t => {
    const env = browser(t, {width, height});
    await prepareReferenceImage(new File([jpeg], 'synthetic.jpg', {type: 'image/jpeg'}));
    assert.deepEqual([env.drawn[0].w, env.drawn[0].h], [1024, 768]);
    assert.equal(env.closed(), 1);
  });
}

for (const condition of ['bitmapFails', 'bitmapMissing']) {
  test(`uses the browser image decoder when ${condition}, then releases the input URL`, async t => {
    const env = browser(t, {[condition]: true});
    const result = await prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'}));
    assert.equal(env.imageLoads(), 1);
    assert.equal(env.drawn[0].w, 1024);
    assert.deepEqual(env.revoked, [env.created[0].url]);
    assert.ok(!env.revoked.includes(result.previewUrl));
  });
}

test('failed decoders give a recoverable error and release the temporary URL', async t => {
  const env = browser(t, {bitmapFails: true, imageFails: true});
  await assert.rejects(prepareReferenceImage(new File([heic], 'synthetic.heic', {type: 'image/heic'})),
    /IMAGE_DECODE_FAILED/);
  assert.equal(env.drawn.length, 0);
  assert.equal(env.created.length, 1);
  assert.deepEqual(env.revoked, [env.created[0].url]);
});

test('rejects SVG or unrelated bytes even when the filename and MIME claim PNG', async t => {
  const env = browser(t);
  for (const content of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'not an image']) {
    await assert.rejects(prepareReferenceImage(new File([content], 'synthetic.png', {type: 'image/png'})),
      /IMAGE_FORMAT_INVALID/);
  }
  assert.equal(env.drawn.length, 0);
  assert.equal(env.created.length, 0);
});

test('rejects unsupported extensions and mismatched content before decoding', async t => {
  const env = browser(t);
  for (const [bytes, name] of [[png, 'synthetic.gif'], [png, 'synthetic.jpg'],
    [jpeg, 'synthetic.svg'], [heic, 'synthetic.avif'], [png, 'png']]) {
    await assert.rejects(prepareReferenceImage(new File([bytes], name)), /IMAGE_FORMAT_INVALID/);
  }
  assert.equal(env.closed(), 0);
  assert.equal(env.imageLoads(), 0);
  assert.equal(env.drawn.length, 0);
});

test('a JPEG that neither browser decoder can read is rejected before upload', async t => {
  const env = browser(t, {bitmapFails:true, imageFails:true});
  await assert.rejects(prepareReferenceImage(new File([jpeg], 'broken.jpeg')), /IMAGE_DECODE_FAILED/);
  assert.equal(env.drawn.length, 0);
  assert.deepEqual(env.revoked, [env.created[0].url]);
});

test('keeps byte and pixel limits, and releases decoded resources on oversized input', async t => {
  const env = browser(t, {width: 10000, height: 6000});
  await assert.rejects(prepareReferenceImage(new File([png, new Uint8Array(8 * 1024 * 1024)], 'synthetic.png',
    {type: 'image/png'})), /IMAGE_TOO_LARGE/);
  assert.equal(env.closed(), 0);
  await assert.rejects(prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'})),
    /IMAGE_TOO_LARGE/);
  assert.equal(env.closed(), 1);
  assert.equal(env.created.length, 0);
});

test('keeps the server PNG size limit and closes the source when encoding fails', async t => {
  const env = browser(t, {outputSize: 2 * 1024 * 1024 + 1});
  await assert.rejects(prepareReferenceImage(new File([png], 'synthetic.png', {type: 'image/png'})),
    /IMAGE_TOO_LARGE/);
  assert.equal(env.closed(), 1);
  assert.equal(env.created.length, 0);
});
