import {createPortableQC,digest,sha256} from '../qc/portable-qc.mjs';
import {registrationEvidence} from '../qc/registration-evidence.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../qc/visual-policy.mjs';
import {createOperationProvenance} from './provenance.mjs';
import {decodeCompleteWave} from './bootstrap.mjs';
import {operationBinding} from '../../cloud/generation/cue-contract.mjs';
import {generationIdentity} from '../../cloud/generation/dispatch.mjs';

const audioHoldReasons=new Set(`BOUNDED_AUTHORIZED_BYTES_REQUIRED SAME_GENERATION_BINDING_REQUIRED ASSIGNED_ASSET_ID_REQUIRED
 CURRENT_PARENT_CONTEXT_BINDING_REQUIRED ACTUAL_BYTE_HASH_MISMATCH TRUSTED_BYTE_ORIGIN_REQUIRED
 CURRENT_SOURCE_CHANGED_OR_UNVERIFIED EXPLICIT_AUDIO_LAYOUT_REQUIRED AUDIO_DECODE_OR_DSP_FAILED
 FRESH_BOUND_AUDIO_MEASUREMENT_REQUIRED ACTUAL_CUE_BYTES_REQUIRED SOURCE_AUDIO_QC_FAILED ENDPOINT_PROFILE_REQUIRED
 ACTUAL_24_SECOND_TAIL_REQUIRED EXACT_PARENT_CONTEXT_PCM_REQUIRED BOUND_NATIVE_TRANSITION_QC_REQUIRED`.split(/\s+/));
// The outer code is unchanged. Attach only fixed local admission codes, never
// profile objects, adapter messages, private media references or provider data.
export function prototypeAudioQCHold(reasons){
  const error=Error('PROTOTYPE_AUDIO_QC_HOLD');let tail=error;
  for(const code of [...new Set(Array.isArray(reasons)?reasons:[])].filter(x=>audioHoldReasons.has(x)).slice(0,4)){
    const cause=Error(code);Object.defineProperty(tail,'cause',{value:cause});tail=cause;
  }
  return error;
}

const selectorCurrent=s=>({clipId:s.music.clipId,sha256:s.music.sha256,contextSha256:s.music.contextSha256,
  profile:s.music.profile,playbackRevision:s.playback.revision,playedUntilFrame:s.playback.playedUntilFrame});
// Existing Mac composition: provider bytes -> real native QC -> private saved
// artifacts -> registration evidence. It performs no provider submission.
export function createPrototypePipeline({readOperation,readCurrent,store,native,readVisualPlan,
  readGenerationSource,readSavedRecord,readExactReview,fetchImpl}={}){
  if(!store?.save||!store?.read||!native?.inspectAudio||!native?.inspectVideo||typeof readVisualPlan!=='function')
    throw Error('PROTOTYPE_PIPELINE_DEPENDENCIES_REQUIRED');
  const provenance=createOperationProvenance({readOperation,readSavedRecord,fetchImpl}),renders=new Map(),completed=new Map();
  const pending=new Map();let serial=Promise.resolve(),closed=false;
  const service={
    async inspectGeneration({roomId,operation}){
      const readSource=()=>readGenerationSource?readGenerationSource({roomId,operation}):readCurrent(roomId);
      const source=await readSource(),expected={clipId:source.music.clipId,sha256:source.music.sha256,
        contextSha256:source.music.contextSha256,playbackRevision:source.playback.revision};
      if(source.music.clipId!==operation.permit.source.music.clipId||source.music.sha256!==operation.permit.source.music.sha256||
        source.music.contextSha256!==operation.permit.source.music.contextSha256||source.playback.revision!==operation.permit.source.playback.revision)
        throw Error('PROTOTYPE_SOURCE_CHANGED');
      const prior=completed.get(operation.operationId);
      if(prior){if(await digest(prior.source)!==await digest(expected))throw Error('PROTOTYPE_SOURCE_CHANGED');return structuredClone(prior.evidence);}
      const verifyCurrentSource=async value=>{
        const fresh=await readSource();
        return value.clipId===fresh.music.clipId&&value.sha256===fresh.music.sha256&&value.contextSha256===fresh.music.contextSha256&&
          value.playbackRevision===fresh.playback.revision;
      };
      const exact=operation.permit.visualReviewMode==='exact';
      if(!exact&&await digest(operation.permit.visualPolicy??null)!==await digest(TECHNICAL_VISUAL_POLICY))throw Error('FROZEN_VISUAL_POLICY_REQUIRED');
      const qc=createPortableQC({...native,verifyProvenance:provenance.verifyProvenance,verifyCurrentSource,
        ...(exact?{verifyReview:readExactReview}:{visualPolicy:TECHNICAL_VISUAL_POLICY})});
      const [audioRaw,videoRaw,parent,context]=await Promise.all([
        provenance.download({roomId,operationId:operation.operationId,channel:'music'}),
        provenance.download({roomId,operationId:operation.operationId,channel:'video'}),
        store.read(source.audioAssetId),store.read(source.contextAssetId)]);
      const audioBinding=operationBinding(roomId,operation,'music'),videoBinding=operationBinding(roomId,operation,'video');
      const identity=generationIdentity(operation.operationId).cueId.slice(4);
      // Keep prior immutable artifacts intact, including partially saved legacy
      // FLOAT WAVs whose PEAK timestamp made byte hashes vary on retry.
      const audioId='audio-v2-'+identity,videoId='visual-'+identity;
      const audioFrames=decodeCompleteWave(audioRaw.bytes).frames;
      const layout=audioFrames===24*44100?'tail-only':audioFrames===40*44100?'context-plus-tail':null;
      if(!layout)throw Error('KNOWN_PROVIDER_AUDIO_LAYOUT_REQUIRED');
      const audio=await qc.audio({binding:audioBinding,expectedBinding:audioBinding,assetId:audioId,
        bytes:audioRaw.bytes,sha256:audioRaw.sha256,provenance:audioRaw.provenance,layout,
        source:{bytes:parent.bytes,contextBytes:context.bytes,...expected},expectedSource:expected});
      if(!audio.media.qc.passed||!audio.cueBytes||!audio.renderBytes)throw prototypeAudioQCHold(audio.media.qc.reasons);
      const rawVideoId='clip-'+identity;
      const videoPlan=await readVisualPlan({roomId,operation,binding:videoBinding,newClip:{clipId:rawVideoId,
        bytes:videoRaw.bytes,sha256:videoRaw.sha256,provenance:videoRaw.provenance}});
      if(!videoPlan?.manifest||!Array.isArray(videoPlan.clips))throw Error('EXISTING_VISUAL_PLAN_REQUIRED');
      const video=await qc.video({binding:videoBinding,expectedBinding:videoBinding,assetId:videoId,
        referenceSha256:operation.permit.source.video.referenceSha256,...videoPlan});
      if(video.qc.passed!==true||video.actualGenerationThisRun!==true)throw Error('PROTOTYPE_VIDEO_QC_HOLD');
      if(!await verifyCurrentSource(expected))throw Error('PROTOTYPE_SOURCE_CHANGED');
      await store.save({id:audioId,bytes:audio.cueBytes,contentType:'audio/wav',binding:audioBinding,provenance:{kind:'provider',
        operationId:operation.operationId,requestId:operation.stages.music.requestId,resultSha256:operation.stages.music.result.resultSha256}});
      const renderId='render-v2-'+identity;
      await store.save({id:renderId,bytes:audio.renderBytes,contentType:'audio/wav',binding:audioBinding,provenance:{kind:'verified-render'}});
      // Store exactly the canonical JSON used by the QC digest, including nested keys.
      const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
      const fullManifest=new TextEncoder().encode(JSON.stringify(canonical(videoPlan.manifest)));
      if(await sha256(fullManifest)!==video.asset.sha256||await digest(videoPlan.manifest)!==video.asset.sha256)throw Error('VISUAL_MANIFEST_HASH_MISMATCH');
      await store.save({id:videoId,bytes:fullManifest,contentType:'application/json',binding:videoBinding});
      for(const clip of videoPlan.clips){
        if(clip.clipId===rawVideoId)await store.save({id:rawVideoId,bytes:clip.bytes,contentType:'video/mp4',binding:videoBinding,
          provenance:{kind:'provider',requestId:operation.stages.video.requestId,resultSha256:operation.stages.video.result.resultSha256}});
      }
      const registered=await registrationEvidence({music:audio.media,video,expectedBinding:audioBinding,verifySaved:x=>store.verifySaved(x)});
      if(registered.status!=='QC_READY')throw Error(registered.reasons.join(','));
      // Keyed by operation: a replayed operation can reuse a cueId.
      renders.set(operation.operationId,{assetId:renderId,receipt:audio.media.transitionEvidence,source:expected});
      completed.set(operation.operationId,{evidence:registered.evidence,source:expected});
      return structuredClone(registered.evidence);
    },
    async inspectJoin({current,candidate}){
      const r=renders.get(candidate.operationId);
      if(!r||r.source.clipId!==current.clipId||r.source.sha256!==current.sha256||r.source.contextSha256!==current.contextSha256||
        r.source.playbackRevision!==current.playbackRevision)return null;
      return structuredClone(r.receipt);
    },
    async readRender({cue}){const record=renders.get(cue.operationId);if(!record)throw Error('RENDER_NOT_AVAILABLE');return structuredClone(record);},
    async currentForSelector(roomId){const s=await readCurrent(roomId);return{...selectorCurrent(s),actual:s.playback.actual===true};},
    close(){closed=true;provenance.close();renders.clear();completed.clear();},
  };
  return {...service,inspectGeneration(input){
    if(closed)return Promise.reject(Error('PROTOTYPE_PIPELINE_CLOSED'));
    const id=input.operation.operationId;if(pending.has(id))return pending.get(id);
    if(pending.size>=2)return Promise.reject(Error('NATIVE_QC_BUSY'));
    const work=serial.then(()=>{if(closed)throw Error('PROTOTYPE_PIPELINE_CLOSED');return service.inspectGeneration(input);})
      .finally(()=>pending.delete(id));
    pending.set(id,work);serial=work.catch(()=>{});return work;
  }};
}
