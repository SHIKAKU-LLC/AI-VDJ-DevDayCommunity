import {createHash, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {createPortableNativeRuntime} from '../worker/native-runtime.mjs';
import {prepareMedia} from './media-prepare.mjs';
import {assessTechnicalVisual} from '../../integration/qc/visual-policy.mjs';

const bodyLimit = 28 * 1024 * 1024, fileLimit = 8 * 1024 * 1024;
const shapes = {bootstrap: ['bytes'], reference: ['bytes'], audio: ['bytes', 'sourceBytes', 'contextBytes'], video: ['bytes'], join: ['bytes', 'sourceBytes']};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const output = (value, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}});
const failure = code => { throw Error(code); };

function syntheticWave() {
  const rate = 44100, frames = 24 * rate, bytes = Buffer.alloc(44 + frames * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(0.1 * Math.sin(2 * Math.PI * 220 * i / rate) * 32768);
    bytes.writeInt16LE(sample, 44 + i * 4); bytes.writeInt16LE(sample, 46 + i * 4);
  }
  return bytes;
}

async function decode(request) {
  if (request.headers.get('content-type') !== 'application/json') failure('JSON_REQUIRED');
  const parts = []; let size = 0;
  for await (const part of request.body ?? []) {
    size += part.byteLength;
    if (size > bodyLimit) failure('BODY_TOO_LARGE');
    parts.push(Buffer.from(part));
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts, size).toString('utf8')); } catch { failure('INPUT_INVALID'); }
  if (!value || Object.keys(value).sort().join(',') !== 'action,files,input,requestId' ||
      typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId) || !Object.hasOwn(shapes, value.action) ||
      !value.input || Array.isArray(value.input) || typeof value.input !== 'object' ||
      !value.files || Object.keys(value.files).sort().join(',') !== [...shapes[value.action]].sort().join(',')) failure('INPUT_INVALID');
  if (Object.keys(value.input).some(key => !['inputDigest', 'layout', 'playbackRevision'].includes(key)) ||
      value.input.inputDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.input.inputDigest) ||
      value.input.layout !== undefined && !['tail-only', 'context-plus-tail'].includes(value.input.layout) ||
      value.input.playbackRevision !== undefined && (!Number.isSafeInteger(value.input.playbackRevision) || value.input.playbackRevision < 0)) failure('INPUT_INVALID');
  const files = {}; let bytes = 0;
  for (const [name, file] of Object.entries(value.files)) {
    if (!file || Object.keys(file).sort().join(',') !== 'data,sha256' || typeof file.data !== 'string' ||
        file.data.length > Math.ceil(fileLimit / 3) * 4 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) failure('INPUT_INVALID');
    const decoded = Buffer.from(file.data, 'base64');
    if (!decoded.length || decoded.length > fileLimit || decoded.toString('base64') !== file.data || digest(decoded) !== file.sha256) failure('INPUT_INVALID');
    bytes += decoded.length;
    if (bytes > 20 * 1024 * 1024) failure('BODY_TOO_LARGE');
    files[name] = decoded;
  }
  return {...value, files};
}

// Private Worker-to-Container endpoint. No provider key, external URL, shell
// command, filesystem path or user-supplied QC verdict is accepted by this API.
export function createNativeService({authorize, createRuntime} = {}) {
  if (typeof authorize !== 'function' || typeof createRuntime !== 'function') failure('NATIVE_SERVICE_CONFIGURATION_REQUIRED');
  let active = false, runtime;
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') return output({service: 'ai-vdj-native', alive: true, processorInitialized: runtime !== undefined, busy: active});
      const selfCheck = path === '/self-check';
      const prepare = /^\/prepare\/(audio|video)$/.exec(path);
      if ((!selfCheck && !prepare && path !== '/inspect') || request.method !== 'POST') return output({error: 'NOT_FOUND'}, 404);
      if (!await authorize(request)) return output({error: 'DENIED'}, 403);
      if (active) return output({error: 'BUSY'}, 409);
      active = true;
      try {
        if (prepare) {
          if (request.headers.get('content-type') !== 'application/octet-stream') return output({error: 'INPUT_INVALID'}, 415);
          let size = 0; const parts = [];
          for await (const part of request.body ?? []) {
            size += part.length;
            if (size > 48 * 1024 * 1024) failure('BODY_TOO_LARGE');
            parts.push(Buffer.from(part));
          }
          const seconds = Number(request.headers.get('x-vdj-duration-seconds') ?? 24);
          const contextSeconds = Number(request.headers.get('x-vdj-context-seconds') ?? 16);
          const mediaProfile = request.headers.get('x-vdj-media-profile') ?? 'legacy';
          if (!['legacy', 'club-hd-v1'].includes(mediaProfile)) failure('INPUT_INVALID');
          if (!(prepare[1] === 'audio' ? [12, 24, 60] : [12, 24]).includes(seconds) || ![0, 12, 16].includes(contextSeconds)) failure('INPUT_INVALID');
          const prepared = await prepareMedia(Buffer.concat(parts, size), prepare[1], {seconds, contextSeconds, mediaProfile});
          if (prepare[1] === 'audio') {
            runtime ??= await createRuntime();
            const profile = await runtime.inspectBootstrap(Buffer.from(prepared.audio.data, 'base64'));
            if (profile.frameCount !== seconds * 44100 || profile.sampleRate !== 44100 || profile.channels !== 2) failure('AUDIO_FORMAT_INVALID');
            if (profile.nonfiniteSamples !== 0 || !Number.isFinite(profile.loudness?.truePeakDbtp) || profile.loudness.truePeakDbtp > -.3 ||
                profile.clippedFraction > .001 || profile.activity?.effectiveSilence !== false) failure('AUDIO_QC_HOLD');
            prepared.quality = {passed: true, truePeakDbtp: profile.loudness.truePeakDbtp, nonfiniteSamples: profile.nonfiniteSamples};
          } else {
            runtime ??= await createRuntime();
            const bytes = Buffer.from(prepared.video.data, 'base64');
            const measured = await runtime.native.inspectVideo({bytes, inputDigest: digest(bytes)});
            if (!measured.fullyDecoded || measured.hasAudioTrack || measured.width !== prepared.width || measured.height !== prepared.height ||
                Math.abs(measured.durationSeconds - seconds) > .05 || measured.decodedFrames !== seconds * 24) failure('VIDEO_FORMAT_INVALID');
            const verdict = assessTechnicalVisual(measured);
            if (!verdict.passed) return output({error: verdict.reasons[0] ?? 'VIDEO_QC_HOLD'}, 422);
            prepared.quality = {passed: true, decodedFrames: measured.decodedFrames};
          }
          return output(prepared);
        }
        if (selfCheck) {
          runtime ??= await createRuntime();
          const bytes = syntheticWave(), result = await runtime.inspectBootstrap(bytes);
          if (result.assetSha256 !== digest(bytes) || result.frameCount !== 24 * 44100 || result.sampleRate !== 44100 ||
              result.channels !== 2 || result.nonfiniteSamples !== 0) failure('RESULT_INVALID');
          return output({kind: 'synthetic-bootstrap-check-v1', passed: true, frameCount: result.frameCount,
            sampleRate: result.sampleRate, channels: result.channels});
        }
        const {action, input, files, requestId} = await decode(request);
        runtime ??= await createRuntime();
        const data = {...input, ...files};
        const result = action === 'bootstrap' ? await runtime.inspectBootstrap(files.bytes) :
          action === 'reference' ? await runtime.inspectReference(files.bytes) :
          await runtime.native[{audio: 'inspectAudio', video: 'inspectVideo', join: 'inspectJoin'}[action]](data);
        const measurements = {...result}, artifacts = {};
        for (const key of ['cueBytes', 'renderBytes']) if (measurements[key] !== undefined) {
          const bytes = measurements[key];
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * 1024 * 1024) failure('RESULT_INVALID');
          artifacts[key] = {data: Buffer.from(bytes).toString('base64'), sha256: digest(bytes)};
          delete measurements[key];
        }
        if (Buffer.byteLength(JSON.stringify(measurements)) > 1024 * 1024) failure('RESULT_INVALID');
        return output({requestId, measurements, artifacts});
      } catch (error) {
        const status = {JSON_REQUIRED: 415, INPUT_INVALID: 400, BODY_TOO_LARGE: 413}[error.message];
        const known = ['AUDIO_FORMAT_INVALID', 'AUDIO_QC_HOLD', 'VIDEO_FORMAT_INVALID', 'MEDIA_INPUT_INVALID',
          'MEDIA_RESULT_INVALID', 'MEDIA_PROCESS_FAILED', 'BOOTSTRAP_MEASUREMENT_FAILED'];
        return output({error: status || known.includes(error.message) ? error.message : 'NATIVE_MEASUREMENT_FAILED'}, status ?? 422);
      } finally { active = false; }
    },
    async close() { await runtime?.close(); },
  };
}

async function start() {
  const expected = Buffer.from(process.env.VDJ_RUNTIME_AUTH ?? '');
  if (expected.length < 32) failure('NATIVE_SERVICE_AUTH_REQUIRED');
  const service = createNativeService({
    authorize: request => {
      const presented = Buffer.from(request.headers.get('x-vdj-runtime-auth') ?? '');
      return presented.length === expected.length && timingSafeEqual(presented, expected);
    },
    createRuntime: () => createPortableNativeRuntime({python: '/opt/venv/bin/python', timeoutMs: 120000}),
  });
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const incoming = new Request(new URL(request.url, 'http://container.internal'), {method, headers: request.headers,
        ...(['GET', 'HEAD'].includes(method) ? {} : {body: Readable.toWeb(request), duplex: 'half'})});
      const outgoing = await service.fetch(incoming);
      response.writeHead(outgoing.status, Object.fromEntries(outgoing.headers));
      if (outgoing.body) Readable.fromWeb(outgoing.body).pipe(response); else response.end();
    } catch { response.writeHead(500); response.end(); }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 10000;
  server.listen(8080, '0.0.0.0');
  process.once('SIGTERM', () => server.close(() => void service.close().finally(() => process.exit(0))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { process.stderr.write('NATIVE_SERVICE_START_FAILED\n'); process.exitCode = 1; });
}
