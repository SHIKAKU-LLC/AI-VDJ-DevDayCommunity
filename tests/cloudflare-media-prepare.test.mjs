import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareMedia} from '../cloud/cloudflare/media-prepare.mjs';
import {createNativeService} from '../cloud/cloudflare/native-service.mjs';
import {createPortableNativeRuntime} from '../cloud/worker/native-runtime.mjs';
const exec = promisify(execFile);

test('native preparation produces a playable stereo tail, context and silent 480P video from synthetic media', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdj-media-test-'));
  const service = createNativeService({authorize: async () => true,
    createRuntime: () => createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON})});
  try {
    const audio = join(dir, 'source.wav'), video = join(dir, 'source.mp4');
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=40', '-ac', '2', '-c:a', 'pcm_f32le', audio]);
    const response = await service.fetch(new Request('http://native.internal/prepare/audio', {method: 'POST',
      headers: {'content-type': 'application/octet-stream'}, body: await readFile(audio)}));
    assert.equal(response.status, 200);
    const prepared = await response.json();
    assert.equal(prepared.quality.passed, true);
    assert.equal(prepared.duration, 24);
    for (const kind of ['audio', 'context']) {
      const path = join(dir, kind + '.wav'); await writeFile(path, Buffer.from(prepared[kind].data, 'base64'));
      const result = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout);
      assert.equal(result.streams[0].codec_name, 'pcm_s16le'); assert.equal(result.streams[0].channels, 2);
      assert.equal(Number(result.streams[0].sample_rate), 44100); assert.equal(Number(result.format.duration), kind === 'audio' ? 24 : 16);
    }
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=24', '-c:v', 'libx264', '-threads', '1', video]);
    const videoResponse = await service.fetch(new Request('http://native.internal/prepare/video', {method: 'POST',
      headers: {'content-type': 'application/octet-stream'}, body: await readFile(video)}));
    assert.equal(videoResponse.status, 200);
    const rendered = await videoResponse.json(); assert.equal(rendered.quality.passed, true);
    assert.equal(rendered.duration, 24); assert.equal(rendered.quality.decodedFrames, 576);
    const path = join(dir, 'ready.mp4'); await writeFile(path, Buffer.from(rendered.video.data, 'base64'));
    const result = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path])).stdout);
    assert.equal(result.streams.length, 1); assert.equal(result.streams[0].codec_name, 'h264');
    assert.equal(result.streams[0].width, 854); assert.equal(result.streams[0].height, 480);
    await assert.rejects(prepareMedia(new Uint8Array(0), 'audio'), /MEDIA_INPUT_INVALID/);
  } finally { await service.close(); await rm(dir, {recursive: true, force: true}); }
});
