import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {decodeCompleteWave} from '../../integration/runtime/bootstrap.mjs';

const fail = code => {throw new DispatchError(code);};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const scopeOf = ({roomId, sessionId, controlRevision}) => ({roomId, sessionId, controlRevision});
const equal = (a,b) => cueDigest(scopeOf(a)) === cueDigest(scopeOf(b));
const recordId = scope => 'bootstrap-authority-' + cueDigest(scopeOf(scope)).slice(0, 44);

// A fixed server configuration selects approved private assets. HTTP callers
// cannot select a source, QC flag or initial graph. Native bootstrap inspection
// creates the immutable authority; later reads physically recheck all assets.
export function createProductionBootstrapAuthority({enabled = false, roomId, readScope, worker, assetStore,
  sourceStore, configuration, now = Date.now} = {}) {
  if (typeof readScope !== 'function' || typeof worker?.prepareBootstrap !== 'function' || !assetStore?.save || !assetStore?.read ||
      !assetStore?.verifySaved || !sourceStore?.save || typeof now !== 'function') fail('BOOTSTRAP_AUTHORITY_PORTS_REQUIRED');
  let prepared=null,closed=false;
  const clear=()=>{for(const asset of prepared?.assets??[])asset.bytes.fill(0);prepared=null;};
  const active = () => {if (!enabled||closed) fail('BOOTSTRAP_AUTHORITY_NOT_ACTIVATED');};
  async function scope() {
    active(); const value = await readScope({roomId}), time = now();
    if (value.roomId !== roomId || !Number.isSafeInteger(time) || value.expiresAtMs <= time) fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    return value;
  }
  async function physical(id, expected) {
    const record = await assetStore.read(id);
    if (!(record?.bytes instanceof Uint8Array) || record.bytes.length < 1 || record.bytes.length > 32 * 1024 * 1024 ||
        record.assetId !== id || record.byteLength !== record.bytes.length || record.sha256 !== expected || sha(record.bytes) !== expected)
      fail('BOOTSTRAP_AUTHORITY_PHYSICAL_CHANGED');
    const proof = await assetStore.verifySaved({binding: record.binding, asset: {assetId: id, sha256: expected}});
    if (proof?.privateSaved !== true || proof.checksumVerified !== true || proof.assetId !== id || proof.sha256 !== expected ||
        cueDigest(proof.binding) !== cueDigest(record.binding)) fail('BOOTSTRAP_AUTHORITY_PHYSICAL_CHANGED');
    return record;
  }
  async function read(input) {
    const first = await scope(); if (!equal(input, first)) fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    const record = await assetStore.read(recordId(first));
    if (record?.contentType !== 'application/json' || !(record.bytes instanceof Uint8Array) || record.bytes.length > 65536 ||
        record.provenance?.kind !== 'verified-bootstrap-authority') fail('BOOTSTRAP_AUTHORITY_RECORD_REQUIRED');
    await physical(record.assetId, record.sha256);
    let body; try {body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(record.bytes));} catch {fail('BOOTSTRAP_AUTHORITY_RECORD_REQUIRED');}
    const {recordSha256, ...value} = body ?? {};
    if (!hash(recordSha256) || cueDigest(value) !== recordSha256 || !equal(value, first) || value.kind !== 'server-selected-source-start-v1' ||
        value.serverQC !== true || value.mode !== 'bootstrap' || !hash(value.qcEvidenceSha256) ||
        value.sourceSha256 !== cueDigest(cueSourceIdentity(value.source)) || value.source.playback.actual !== false)
      fail('BOOTSTRAP_AUTHORITY_RECORD_REQUIRED');
    const source = value.source;
    const [audio, context, reference] = await Promise.all([physical(source.audioAssetId, source.music.sha256),
      physical(source.contextAssetId, source.music.contextSha256), physical(source.referenceAssetId, source.video.referenceSha256)]);
    const decoded = decodeCompleteWave(audio.bytes);
    if (decoded.frames !== 24 * 44100 || audio.provenance?.kind !== 'owner-supplied-bootstrap' ||
        source.music.profile?.assetSha256 !== audio.sha256 || context.provenance?.kind !== 'owner-supplied-bootstrap' ||
        !['image/png', 'image/jpeg'].includes(reference.contentType)) fail('BOOTSTRAP_AUTHORITY_PHYSICAL_CHANGED');
    const latest=await scope();
    if (!equal(first, latest)||first.expiresAtMs!==latest.expiresAtMs) fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    if(!prepared||!equal(prepared.scope,first)||prepared.scope.expiresAtMs!==first.expiresAtMs||
      cueDigest(prepared.value)!==cueDigest(value)){
      clear();const assets=[audio,context,reference].map(asset=>structuredClone(asset));
      prepared={scope:{...first},value:structuredClone(value),audio:assets[0],assets};
    }
    return value;
  }
  function admitted(input){
    active();const first=input,saved=prepared;
    if(!saved||!equal(saved.scope,first)||saved.scope.expiresAtMs!==first.expiresAtMs)
      fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    if(first.expiresAtMs<=now())fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    const configured={audioSha256:configuration.audioSha256,referenceSha256:configuration.referenceSha256,
      motifId:configuration.motifId??'owner-reference',fixedBpm:configuration.fixedBpm??145,
      control:configuration.control??{version:1,energy:.4,tension:.3,density:.3,brightness:.45}};
    const source=saved.value.source,persisted={audioSha256:source.music.sha256,referenceSha256:source.video.referenceSha256,
      motifId:source.video.motifId,fixedBpm:source.quality.fixedBpm,control:source.music.control};
    if(cueDigest(configured)!==cueDigest(persisted))fail('APPROVED_BOOTSTRAP_CONFIGURATION_CHANGED');
    return saved;
  }
  async function preparedRead(input){
    const first=await scope(),saved=admitted(first);
    if(!equal(input,first))fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    const latest=await scope();
    if(closed||prepared!==saved||!equal(first,latest)||first.expiresAtMs!==latest.expiresAtMs)
      fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
    return saved;
  }
  return Object.freeze({
    async prepare() {
      const first = await scope();
      if (!configuration || Object.keys(configuration).some(key => !['audioAssetId', 'audioSha256', 'referenceAssetId',
        'referenceSha256', 'motifId', 'fixedBpm', 'control'].includes(key))) fail('APPROVED_BOOTSTRAP_CONFIGURATION_REQUIRED');
      // Existing immutable record is idempotent. Only a typed absent object can
      // enter preparation; authorization/network/corruption errors never do.
      const prior = await (assetStore.readOptional ?? assetStore.read).call(assetStore,recordId(first));
      if (prior) {
        const selected = await read(first), source = selected.source;
        const configured = {audioSha256: configuration.audioSha256, referenceSha256: configuration.referenceSha256,
          motifId: configuration.motifId ?? 'owner-reference', fixedBpm: configuration.fixedBpm ?? 145,
          control: configuration.control ?? {version:1,energy:.4,tension:.3,density:.3,brightness:.45}};
        const persisted = {audioSha256: source.music.sha256, referenceSha256: source.video.referenceSha256,
          motifId: source.video.motifId, fixedBpm: source.quality.fixedBpm, control: source.music.control};
        if (cueDigest(configured) !== cueDigest(persisted)) fail('APPROVED_BOOTSTRAP_CONFIGURATION_CHANGED');
        return selected;
      }
      const prepared = await worker.prepareBootstrap(structuredClone(configuration));
      const source = {...prepared, playback: {...prepared.playback, phase: 'IDLE', playedUntilFrame: 0, actual: false}};
      if (!equal(first, await scope())) fail('BOOTSTRAP_AUTHORITY_SCOPE_CHANGED');
      const evidence = {kind: 'verified-source-context-v1', roomId, originKind: 'owner-supplied-bootstrap',
        parentAssetId: source.audioAssetId, parentSha256: source.music.sha256, contextAssetId: source.contextAssetId,
        contextSha256: source.music.contextSha256, referenceAssetId: source.referenceAssetId,
        referenceSha256: source.video.referenceSha256, contextSeconds: 16, serverAudioQC: true};
      await sourceStore.save({source, sourceEvidence: evidence});
      const value = {...scopeOf(first), kind: 'server-selected-source-start-v1', mode: 'bootstrap', serverQC: true,
        qcEvidenceSha256: cueDigest({evidence, profile: source.music.profile}), sourceSha256: cueDigest(cueSourceIdentity(source)), source};
      const bytes = new TextEncoder().encode(JSON.stringify({...value, recordSha256: cueDigest(value)}));
      if (bytes.length > 65536) fail('BOOTSTRAP_AUTHORITY_RECORD_REQUIRED');
      await assetStore.save({id: recordId(first), bytes, contentType: 'application/json', binding: {kind: 'owner-supplied-bootstrap'},
        provenance: {kind: 'verified-bootstrap-authority', actualGenerationThisRun: false}});
      return read(first);
    },
    readStartAuthority: read,
    // Runtime playback reuses only our physically verified immutable snapshot.
    // Admission still calls readStartAuthority and rereads private storage.
    async readPreparedAuthority(input){if(!prepared)await read(input);return structuredClone((await preparedRead(input)).value);},
    // Only a server operation that already read the current owner-bound scope
    // may use this immutable admission. Mutable graph/Stop checks stay outside.
    async readAdmittedAuthority(input){if(!prepared)await read(input);return structuredClone(admitted(input).value);},
    // Private playback-only reads. The enclosing typed playback operation
    // authenticates and brackets these immutable bytes with fresh scope checks.
    // Generation/admission continues using the original physical asset store.
    async readPlaybackAsset(assetId){
      active();const asset=prepared?.scope.expiresAtMs>now()&&prepared.assets.find(a=>a.assetId===assetId);
      return asset?structuredClone(asset):assetStore.read(assetId);
    },
    async verifyPlaybackSaved(input){
      active();const asset=prepared?.scope.expiresAtMs>now()&&prepared.assets.find(a=>a.assetId===input?.asset?.assetId);
      if(!asset)return assetStore.verifySaved(input);
      if(asset.sha256!==input.asset.sha256||sha(asset.bytes)!==asset.sha256||cueDigest(asset.binding)!==cueDigest(input.binding))
        fail('BOOTSTRAP_AUTHORITY_PHYSICAL_CHANGED');
      return {privateSaved:true,checksumVerified:true,assetId:asset.assetId,sha256:asset.sha256,binding:structuredClone(asset.binding)};
    },
    async startup() {
      if(!prepared)await this.prepare();
      const saved=await preparedRead(await scope()),selected=saved.value,source=selected.source;
      const asset=saved.audio, decoded = decodeCompleteWave(asset.bytes);
      return {descriptor: {assetId: asset.assetId, sha256: asset.sha256, mimeType: 'audio/wav', byteLength: asset.byteLength,
        pcmSha256: sha(new Uint8Array(decoded.pcm.buffer, decoded.pcm.byteOffset, decoded.pcm.byteLength))},
        source: {actual: false, clipId: source.music.clipId, sha256: source.music.sha256, contextSha256: source.music.contextSha256,
          playbackRevision: 0, frameCount: decoded.frames}, mode: 'bootstrap'};
    },
    close(){closed=true;clear();},
  });
}
