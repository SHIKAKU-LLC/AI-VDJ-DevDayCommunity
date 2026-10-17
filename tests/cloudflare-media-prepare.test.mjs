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
import {decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
const exec = promisify(execFile);

test('flow profile preserves compatible H264 frames and fully inspects 1088-line output', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdj-remux-test-'));
  const service = createNativeService({authorize: async () => true,
    createRuntime: () => createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON})});
  try {
    const path = join(dir, 'source.mp4');
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1088:rate=24:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-threads', '1', path]);
    const response = await service.fetch(new Request('http://native.internal/prepare/video', {method: 'POST',
      headers: {'content-type': 'application/octet-stream', 'x-vdj-duration-seconds': '12', 'x-vdj-media-profile': 'club-flow-v1'},
      body: await readFile(path)}));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.copiedVideo, true); assert.equal(result.height, 1088);
    assert.equal(result.quality.decodedFrames, 288); assert.equal(result.quality.passed, true);
    const output = join(dir, 'output.mp4'); await writeFile(output, Buffer.from(result.video.data, 'base64'));
    const frameHash = async file => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
    assert.equal(await frameHash(path), await frameHash(output));
  } finally { await service.close(); await rm(dir, {recursive: true, force: true}); }
});

test('full-frame visual inspection retains black, static and rapid-flash rejection', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdj-visual-gates-'));
  const runtime = await createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON});
  try {
    const {assessTechnicalVisual} = await import('../integration/qc/visual-policy.mjs');
    for (const [name, filter, reason] of [
      ['black', 'color=black:size=320x180:rate=24:duration=2', 'UNIFORM_BLACK_OR_WHITE_VIDEO'],
      ['static', 'color=gray:size=320x180:rate=24:duration=2', 'STATIC_VIDEO_HOLD'],
      ['flash', "nullsrc=size=320x180:rate=24:duration=2,geq=lum='if(mod(N,2),235,16)':cb=128:cr=128", 'RAPID_LUMA_TRANSITIONS_HOLD'],
    ]) {
      const path = join(dir, name + '.mp4');
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-threads', '1', path]);
      const measured = await runtime.native.inspectVideo({bytes: await readFile(path), inputDigest: 'a'.repeat(64)});
      assert.equal(measured.decodedFrames, 48); assert.equal(measured.fullyDecoded, true);
      assert.ok(assessTechnicalVisual(measured).reasons.includes(reason));
    }
  } finally { await runtime.close(); await rm(dir, {recursive: true, force: true}); }
});

test('club profile preserves 1080P detail and raises bass relative to the midrange', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdj-club-test-'));
  const service = createNativeService({authorize: async () => true,
    createRuntime: () => createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON})});
  try {
    const audio = join(dir, 'source.wav'), video = join(dir, 'source.mp4');
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=0.15*sin(2*PI*60*t)+0.15*sin(2*PI*1000*t):s=48000:d=12', '-ac', '2', audio]);
    const bytes = await readFile(audio);
    const legacy = await prepareMedia(bytes, 'audio', {seconds: 12});
    const club = await prepareMedia(bytes, 'audio', {seconds: 12, mediaProfile: 'club-hd-v1'});
    function bandRatio(result) {
      const wave = decodeCompleteWave(Buffer.from(result.audio.data, 'base64'));
      const amplitude = frequency => {
        let re = 0, im = 0;
        for (let i = 44100; i < 88200; i++) {
          re += wave.pcm[i * 2] * Math.cos(2 * Math.PI * frequency * i / 44100);
          im += wave.pcm[i * 2] * Math.sin(2 * Math.PI * frequency * i / 44100);
        }
        return Math.hypot(re, im);
      };
      return amplitude(60) / amplitude(1000);
    }
    assert.ok(bandRatio(club) > bandRatio(legacy) * 1.15);
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', video]);
    const response = await service.fetch(new Request('http://native.internal/prepare/video', {method: 'POST',
      headers: {'content-type': 'application/octet-stream', 'x-vdj-duration-seconds': '12', 'x-vdj-media-profile': 'club-hd-v1'},
      body: await readFile(video)}));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.width, 1920); assert.equal(result.height, 1080);
    assert.equal(result.quality.decodedFrames, 288); assert.equal(result.quality.passed, true);
  } finally { await service.close(); await rm(dir, {recursive: true, force: true}); }
});

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
test('twelve-second H3 media and music with legacy context pass real native inspection', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdj-twelve-test-'));
  const service = createNativeService({authorize: async () => true,
    createRuntime: () => createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON})});
  const headers = {'content-type': 'application/octet-stream', 'x-vdj-duration-seconds': '12', 'x-vdj-context-seconds': '16'};
  try {
    const audio = join(dir, 'source.wav'), video = join(dir, 'source.mp4');
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=28', '-ac', '2', '-c:a', 'pcm_f32le', audio]);
    const a = await service.fetch(new Request('http://native.internal/prepare/audio', {method: 'POST', headers, body: await readFile(audio)}));
    assert.equal(a.status, 200); const prepared = await a.json();
    assert.equal(prepared.duration, 12); assert.equal(prepared.quality.passed, true);
    const path = join(dir, 'context.wav'); await writeFile(path, Buffer.from(prepared.context.data, 'base64'));
    const meta = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', path])).stdout);
    assert.equal(Number(meta.format.duration), 12);
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=12.6', '-c:v', 'libx264', '-threads', '1', video]);
    const v = await service.fetch(new Request('http://native.internal/prepare/video', {method: 'POST', headers, body: await readFile(video)}));
    assert.equal(v.status, 200); const rendered = await v.json();
    assert.equal(rendered.duration, 12); assert.equal(rendered.quality.decodedFrames, 288);
    await assert.rejects(prepareMedia(await readFile(video), 'video', {seconds: 24}), /MEDIA_INPUT_INVALID/);
  } finally { await service.close(); await rm(dir, {recursive: true, force: true}); }
});

test('sixty-second music retains the full passage and a sixteen-second continuation context', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdj-long-music-test-'));
  const service = createNativeService({authorize: async () => true,
    createRuntime: () => createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON})});
  try {
    const input = join(dir, 'source.wav');
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=76', '-ac', '2', '-c:a', 'pcm_f32le', input]);
    const response = await service.fetch(new Request('http://native.internal/prepare/audio', {method: 'POST',
      headers: {'content-type': 'application/octet-stream', 'x-vdj-duration-seconds': '60', 'x-vdj-context-seconds': '16'},
      body: await readFile(input)}));
    assert.equal(response.status, 200);
    const prepared = await response.json();
    assert.equal(prepared.duration, 60); assert.equal(prepared.quality.passed, true);
    for (const kind of ['audio', 'context']) {
      const path = join(dir, kind + '.wav'); await writeFile(path, Buffer.from(prepared[kind].data, 'base64'));
      const meta = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout);
      assert.equal(Number(meta.format.duration), kind === 'audio' ? 60 : 16);
      assert.equal(meta.streams[0].channels, 2); assert.equal(Number(meta.streams[0].sample_rate), 44100);
    }
  } finally { await service.close(); await rm(dir, {recursive: true, force: true}); }
});
