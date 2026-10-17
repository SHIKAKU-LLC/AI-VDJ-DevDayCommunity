import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decodeSavedWave, savedContextSha} from '../../snapshot/app/runtime/saved-room-media.mjs';
import {cueDigest,validateCueSource} from '../../snapshot/app/runtime/intent-compiler.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile), RATE = 44100;
export function decodeCompleteWave(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.length > 32 * 1024 * 1024 || b.toString('ascii',0,4) !== 'RIFF' ||
      b.readUInt32LE(4) + 8 !== b.length || b.toString('ascii',8,12) !== 'WAVE') throw Error('COMPLETE_WAVE_REQUIRED');
  let at = 12; const found = new Set();
  while (at < b.length) {
    if (at + 8 > b.length) throw Error('PARTIAL_WAVE_CHUNK');
    const tag = b.toString('ascii', at, at + 4), n = b.readUInt32LE(at + 4);
    if (at + 8 + n > b.length || ['fmt ', 'data'].includes(tag) && found.has(tag)) throw Error('INVALID_WAVE_CHUNK');
    if (tag === 'fmt ') { if (n < 16) throw Error('WAVE_FORMAT_REQUIRED'); found.add(tag); }
    if (tag === 'data') found.add(tag);
    at += 8 + n + n % 2;
  }
  if (at !== b.length || found.size !== 2) throw Error('COMPLETE_WAVE_REQUIRED');
  const audio = decodeSavedWave(b);
  if (!Number.isSafeInteger(audio.frames)) throw Error('STEREO_FRAME_REQUIRED');
  return audio;
}
export function contextWave(audio) {
  const n = 16 * RATE;
  if (audio.frames < n) throw Error('SIXTEEN_SECOND_PARENT_REQUIRED');
  const bytes = Buffer.alloc(44 + n * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(2,22);
  bytes.writeUInt32LE(RATE,24); bytes.writeUInt32LE(RATE * 4,28); bytes.writeUInt16LE(4,32); bytes.writeUInt16LE(16,34);
  bytes.write('data',36); bytes.writeUInt32LE(n * 4,40);
  for (let i=0;i<n*2;i++) bytes.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(audio.pcm[(audio.frames-n)*2+i]*32768))),44+i*2);
  if (hash(bytes) !== savedContextSha(audio)) throw Error('CONTEXT_ENCODING_MISMATCH');
  return bytes;
}
export function createBootstrapInspector({python = 'python3', dspModule = fileURLToPath(new URL('../../snapshot/app/runtime/dj-transition-dsp.py',import.meta.url))} = {}) {
  return async bytes => {
    const dir = await mkdtemp(path.join(tmpdir(),'vdj-bootstrap-'));
    try {
      const target = path.join(dir,'source.wav'); await writeFile(target,bytes,{mode:0o600});
      const result = await run(python,[dspModule,'--profile',target],{timeout:45000,maxBuffer:1024*1024,
        env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
      return JSON.parse(result.stdout);
    } catch { throw Error('BOOTSTRAP_MEASUREMENT_FAILED'); }
    finally { await rm(dir,{recursive:true,force:true}); }
  };
}
// The seed is supplied by the owner, not relabelled as this run's generation.
export async function prepareBootstrap({audioBytes, referenceBytes, motifId = 'owner-reference', fixedBpm = 145,
  inspect = createBootstrapInspector(), control = {version:1,energy:.4,tension:.3,density:.3,brightness:.45}} = {}) {
  const sourceBytes=Buffer.from(audioBytes??[]),audio = decodeCompleteWave(sourceBytes);
  if (audio.frames !== 24 * RATE) throw Error('BOOTSTRAP_24_SECOND_SOURCE_REQUIRED');
  const reference = Buffer.from(referenceBytes ?? []);
  const png = reference.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = reference.length > 3 && reference[0] === 255 && reference[1] === 216 && reference[2] === 255;
  if ((!png && !jpeg) || reference.length > 4 * 1024 * 1024) throw Error('OWNER_IMAGE_REFERENCE_REQUIRED');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(motifId) || !Number.isFinite(fixedBpm) || fixedBpm < 60 || fixedBpm > 220)
    throw Error('BOOTSTRAP_CONFIGURATION_REQUIRED');
  const profile = await inspect(Buffer.from(sourceBytes));
  if (profile?.assetSha256 !== audio.sha256 || profile.frameCount !== audio.frames || profile.sampleRate !== RATE || profile.channels !== 2 ||
      !Number.isFinite(profile.loudness?.truePeakDbtp) || profile.loudness.truePeakDbtp > -.3 || profile.nonfiniteSamples !== 0 ||
      !Number.isFinite(profile.clippedFraction) || profile.clippedFraction > .001 || profile.activity?.effectiveSilence !== false ||
      profile.activity?.maxQuietRunSeconds > .5) throw Error('BOOTSTRAP_AUDIO_QC_HOLD');
  const contextBytes = contextWave(audio), contextSha256 = hash(contextBytes), referenceSha256 = hash(reference);
  const clipId = 'seed-' + audio.sha256.slice(0,24);
  const source = {music:{clipId,sha256:audio.sha256,profile,ready:true,contextSeconds:16,contextVerified:true,contextSha256,
    control:structuredClone(control),style:'restrained',genre:'instrumental psytrance'},
    video:{motifId,referenceSha256,motifSnapshotSha256:cueDigest({motifId,referenceSha256})},
    quality:{fixedBpm,tempoConfidence:'assumed',keyConfidence:profile.key?.confidence ?? 'unknown'},
    playback:{phase:'IDLE',revision:0,playedUntilFrame:0}};
  validateCueSource(source);
  return {source,audio,audioBytes:sourceBytes,contextBytes,referenceBytes:reference,
    referenceContentType:png?'image/png':'image/jpeg',
    provenance:{kind:'owner-supplied-bootstrap',actualGenerationThisRun:false,rawSha256:audio.sha256,referenceSha256}};
}

// Persist the verified seed with the IDs the current-source/render adapters use.
// This does not start playback or authorize a provider request.
export async function saveBootstrap({prepared,store}={}) {
  if(!prepared?.source||!store?.save)throw Error('PREPARED_BOOTSTRAP_AND_STORE_REQUIRED');
  const source=prepared.source,binding={kind:'owner-supplied-bootstrap'};
  const audioBytes=prepared.audioBytes;
  if(!audioBytes)throw Error('BOOTSTRAP_BYTES_REQUIRED');
  const audio=await store.save({id:source.music.clipId,bytes:audioBytes,contentType:'audio/wav',binding,provenance:prepared.provenance});
  const context=await store.save({id:'context-'+source.music.contextSha256.slice(0,24),bytes:prepared.contextBytes,contentType:'audio/wav',binding,provenance:prepared.provenance});
  const reference=await store.save({id:'reference-'+source.video.referenceSha256.slice(0,24),bytes:prepared.referenceBytes,
    contentType:prepared.referenceContentType,binding,provenance:prepared.provenance});
  if(audio.sha256!==source.music.sha256||context.sha256!==source.music.contextSha256||reference.sha256!==source.video.referenceSha256)
    throw Error('BOOTSTRAP_SAVED_HASH_MISMATCH');
  return {...structuredClone(source),audioAssetId:audio.assetId,contextAssetId:context.assetId,referenceAssetId:reference.assetId};
}
