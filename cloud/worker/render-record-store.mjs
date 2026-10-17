import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';

const fail = code => {throw new DispatchError(code);};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
// Every record is scoped by its operation: a replay can publish a newer
// operation under a cueId already recorded. Records saved before this scoping
// keep their published IDs and are still read through legacyRenderRecordId.
export const renderRecordId = ({roomId, cueId,operationId,pairCurrent,artifactVersion}) => 'render-record-' + cueDigest({roomId, cueId,
 operationId,...(pairCurrent?{pairCurrent}:artifactVersion?{artifactVersion}:{}),scope:'operation-v1'}).slice(0, 48);
export const legacyRenderRecordId = ({roomId, cueId,pairCurrent,artifactVersion}) => 'render-record-' + cueDigest({roomId, cueId,
 ...(pairCurrent?{pairCurrent}:artifactVersion?{artifactVersion}:{})}).slice(0, 48);

// Private immutable metadata produced only after native inspection. It carries
// the measured receipt/parent source across host reconstruction, never a browser
// QC grant. Physical render, parent and incoming bytes are rechecked by readers.
export function createProductionRenderRecordStore({enabled = false, assetStore} = {}) {
  if (!['read', 'save', 'verifySaved'].every(key => typeof assetStore?.[key] === 'function')) fail('RENDER_RECORD_STORE_REQUIRED');
  const active = () => {if (!enabled) fail('RENDER_RECORD_NOT_ACTIVATED');};
  async function checked(key) {
    const record = await (assetStore.readOptional ?? assetStore.read).call(assetStore,key);
    if (!record) return null;
    if (!(record.bytes instanceof Uint8Array) || record.bytes.length < 1 || record.bytes.length > 65536 ||
        record.assetId !== key || record.byteLength !== record.bytes.length || sha(record.bytes) !== record.sha256 ||
        record.contentType !== 'application/json' || record.provenance?.kind !== 'verified-render-record') fail('RENDER_RECORD_CHANGED');
    const proof = await assetStore.verifySaved({binding: record.binding, asset: {assetId: key, sha256: record.sha256}});
    if (proof?.privateSaved !== true || proof.checksumVerified !== true || proof.assetId !== key || proof.sha256 !== record.sha256 ||
        cueDigest(proof.binding) !== cueDigest(record.binding)) fail('RENDER_RECORD_CHANGED');
    let value;
    try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(record.bytes));} catch {fail('RENDER_RECORD_CHANGED');}
    const {recordSha256, ...body} = value ?? {};
    if (!hash(recordSha256) || cueDigest(body) !== recordSha256 || body.kind !== 'private-native-render-v1' ||
        cueDigest(body.binding) !== cueDigest(record.binding) || body.operationId !== record.provenance.operationId ||
        !id(body.roomId) || !id(body.cueId) || !id(body.operationId) || !hash(body.evidenceSha256) ||
        !id(body.render?.assetId) || !hash(body.render?.receipt?.renderedSha256)) fail('RENDER_RECORD_CHANGED');
    return body;
  }
  return Object.freeze({
    async save({roomId, operationId, cueId, binding, source, render, evidenceSha256,pairCurrent=null}) {
      active();
      if (!id(roomId) || !id(operationId) || !id(cueId) || binding?.roomId !== roomId || !hash(evidenceSha256) ||
          !source?.audioAssetId || !id(render?.assetId) || !hash(render?.receipt?.renderedSha256)) fail('RENDER_RECORD_INPUT_REQUIRED');
      const archivedSource = {...structuredClone(source), playback: {phase: 'IDLE', revision: source.playback.revision,
        playedUntilFrame: 0, actual: false}};
      if(pairCurrent&&(!hash(pairCurrent.sha256)||!hash(pairCurrent.contextSha256)||!id(pairCurrent.clipId)||
        !Number.isSafeInteger(pairCurrent.playbackRevision)||pairCurrent.playbackRevision<0||
        pairCurrent.clipId!==source.music.clipId||pairCurrent.sha256!==source.music.sha256||
        pairCurrent.contextSha256!==source.music.contextSha256||pairCurrent.playbackRevision!==source.playback.revision))fail('RENDER_RECORD_CURRENT_CHANGED');
      const artifactVersion=!pairCurrent&&render.assetId.startsWith('render-v2-')?'stable-peak-timestamp-v2':null;
      const body = {kind: 'private-native-render-v1', roomId, operationId, cueId, binding: structuredClone(binding),
        ...(artifactVersion?{artifactVersion}:{}),
        ...(pairCurrent?{pairCurrent:structuredClone(pairCurrent)}:{}),
        source: archivedSource, render: structuredClone(render), evidenceSha256};
      const bytes = new TextEncoder().encode(JSON.stringify({...body, recordSha256: cueDigest(body)}));
      if (bytes.length > 65536) fail('RENDER_RECORD_BOUNDED_JSON_REQUIRED');
      // An identical record already published under the legacy ID is reused.
      const legacy = await checked(legacyRenderRecordId(body));
      if (legacy && cueDigest(legacy) === cueDigest(body)) return legacy;
      const key = renderRecordId(body), previous = await checked(key);
      if (previous && cueDigest(previous) !== cueDigest(body)) fail('RENDER_RECORD_IMMUTABLE');
      if (!previous) await assetStore.save({id: key, bytes, contentType: 'application/json', binding: body.binding,
        provenance: {kind: 'verified-render-record', operationId}});
      const saved = await checked(key);
      if (!saved || cueDigest(saved) !== cueDigest(body)) fail('RENDER_RECORD_SAVE_REQUIRED');
      return saved;
    },
    async read({roomId, cue,pairCurrent=null}) {
      active(); if (!id(roomId) || !id(cue?.cueId)) fail('RENDER_RECORD_INPUT_REQUIRED');
      const artifactVersion=!pairCurrent&&cue.music?.asset?.assetId?.startsWith('audio-v2-')?'stable-peak-timestamp-v2':null;
      const ids = {roomId, cueId: cue.cueId,operationId: cue.operationId,...(pairCurrent?{pairCurrent}:artifactVersion?{artifactVersion}:{})};
      const body = await checked(renderRecordId(ids)) ?? await checked(legacyRenderRecordId(ids));
      if (!body || body.roomId !== roomId || body.cueId !== cue.cueId || body.operationId !== cue.operationId ||
          (body.artifactVersion??null)!==artifactVersion ||
          cueDigest(body.binding) !== cueDigest(cue.music?.binding) || body.evidenceSha256 !== cue.evidenceSha256 ||
          (pairCurrent?cueDigest(body.pairCurrent)!==cueDigest(pairCurrent)||body.source.music?.sha256!==pairCurrent.sha256||
            body.source.playback?.revision!==pairCurrent.playbackRevision:body.source.music?.clipId !== cue.music?.parentClipId)) fail('RENDER_RECORD_CUE_CHANGED');
      return structuredClone(body);
    },
  });
}
