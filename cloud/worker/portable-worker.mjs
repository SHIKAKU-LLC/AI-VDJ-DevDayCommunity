import {createHash} from 'node:crypto';
import {prepareBootstrap,saveBootstrap} from '../../integration/runtime/bootstrap.mjs';
import {createPrototypePipeline} from '../../integration/runtime/prototype-pipeline.mjs';
import {createRenderResolver} from '../../integration/runtime/render-resolver.mjs';
import {operationBinding,buildVerifiedCue} from '../generation/cue-contract.mjs';
import {DispatchError} from '../generation/dispatch.mjs';
import {QC_VERSION,digest} from '../../integration/qc/portable-qc.mjs';
import {measuredJoinContract} from '../../snapshot/app/runtime/measured-cut.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {createPortableNativeRuntime} from './native-runtime.mjs';
import {createProductionRenderRecordStore} from './render-record-store.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const checksum=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=reason=>{throw Error(reason);};
const internalOrigin='https://private-worker.fal.media';
// Background preparation renders every join at this playback revision.
export const PAIR_BASE_REVISION=1;
const selector=s=>({clipId:s.music.clipId,sha256:s.music.sha256,contextSha256:s.music.contextSha256,
  profile:structuredClone(s.music.profile),playbackRevision:s.playback.revision,
  playedUntilFrame:s.playback.playedUntilFrame,actual:s.playback.actual===true});
const safeReason=error=>/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message??'')?error.message:'CLOUD_WORKER_INSPECTION_FAILED';
const generationFingerprint=op=>cueDigest({roomId:op.roomId??null,operationId:op.operationId,
  submissionId:op.submissionId,permit:op.permit,plan:op.plan,
  stages:Object.fromEntries(['music','video'].map(channel=>[channel,{state:op.stages[channel].state,
    requestId:op.stages[channel].requestId,result:op.stages[channel].result}]))});
export class PortableWorkerHold extends DispatchError {
  constructor(reason){super('PORTABLE_QC_HOLD');this.message=reason;this.holdReason=reason;}
}

/** Private CPU host only. All dependencies are server-owned, never browser JSON. */
export function createPortableCloudWorker({enabled=false,readOperation,readCurrent,assetStore,
  readGenerationSource,readVisualPlan,readSavedRecord,readExactReview,native,inspectBootstrap,runtime={},enableClipRelativeTimeline=false,persistRenderRecords=false,
  playbackAssetStore=assetStore}={}) {
  if(typeof readOperation!=='function'||typeof readCurrent!=='function'||typeof readVisualPlan!=='function'||
      !['read','save','verifySaved'].every(k=>typeof assetStore?.[k]==='function'))
    fail('CLOUD_WORKER_DEPENDENCIES_REQUIRED');
  let closed=false,pipeline,creating,runtimeHandle;const completed=new Map(),pending=new Map(),inspections=new Set();
  const renderRecords=createProductionRenderRecordStore({enabled:persistRenderRecords,assetStore});
  const playbackRenderRecords=createProductionRenderRecordStore({enabled:persistRenderRecords,assetStore:playbackAssetStore});
  const active=()=>{if(enabled!==true)fail('CLOUD_WORKER_NOT_ACTIVATED');if(closed)fail('CLOUD_WORKER_CLOSED');};
  async function readAsset(assetId,expectedSha256,store=assetStore) {
    if(!id(assetId)||expectedSha256!==undefined&&!checksum(expectedSha256))fail('PRIVATE_ASSET_ID_AND_SHA_REQUIRED');
    const record=await store.read(assetId),bytes=Buffer.from(record?.bytes??[]);
    if(!bytes.length||bytes.length>32*1024*1024||record?.assetId!==assetId||record.byteLength!==bytes.length||
       !checksum(record.sha256)||hash(bytes)!==record.sha256||expectedSha256!==undefined&&record.sha256!==expectedSha256)
      fail('PRIVATE_ASSET_CHECKSUM_MISMATCH');
    return {...structuredClone(record),bytes};
  }
  // Immutable private playback media verified once in this process (bytes
  // re-hashed against their SHA). A reservation only needs to know a prepared
  // join's media exist and match: re-downloading tens of MB per candidate took
  // ~23s per join in production and outlived the 24s source. The browser
  // commit still re-verifies every byte it plays.
  const verifiedPlayback=new Set();
  const readPlaybackAsset=async(id,sha)=>{let record;
    // A full read that fails its checksum (e.g. at commit) revokes the earlier
    // verification, so later reservations re-read and reject that media.
    try{record=await readAsset(id,sha,playbackAssetStore);}catch(error){for(const key of verifiedPlayback)if(key.startsWith(id+':'))verifiedPlayback.delete(key);throw error;}
    verifiedPlayback.add(id+':'+record.sha256);while(verifiedPlayback.size>256)verifiedPlayback.delete(verifiedPlayback.values().next().value);return record;};
  const confirmPlaybackAsset=async(id,sha)=>{if(!id||!checksum(sha)||!verifiedPlayback.has(id+':'+sha))await readPlaybackAsset(id,sha);};
  async function currentSource(roomId) {
    if(!id(roomId))fail('ROOM_ID_REQUIRED');
    const source=structuredClone(await readCurrent(roomId));
    if(!source?.music||!source?.video||!source?.playback||!id(source.audioAssetId)||!id(source.contextAssetId)||
      !checksum(source.music.sha256)||!checksum(source.music.contextSha256)||
      !Number.isSafeInteger(source.playback.revision)||source.playback.revision<0||
      !Number.isSafeInteger(source.playback.playedUntilFrame)||source.playback.playedUntilFrame<0)
      fail('TRUSTED_CURRENT_SOURCE_REQUIRED');
    return source;
  }
  async function operation({roomId,operationId}) {
    if(!id(roomId)||!id(operationId))fail('CLOUD_JOB_IDS_REQUIRED');
    const op=structuredClone(await readOperation({roomId,operationId}));
    if(op?.operationId!==operationId||op.roomId!==undefined&&op.roomId!==roomId||op.stopped||
       op.dispatchAllowed===false||op.plan?.status!=='COMPILED')fail('AUTHORITATIVE_OPERATION_REQUIRED');
    if(!['music','video'].every(c=>op.stages?.[c]?.state==='COMPLETE'))fail('COMPLETE_AV_REQUIRED');
    for(const c of ['music','video']) {
      const result=op.stages[c].result;
      if(!id(result?.assetId)||!checksum(result?.sha256)||!checksum(result?.resultSha256))fail('SAVED_MEDIA_REQUIRED');
      // Discard remote locations entirely. The existing provenance pipeline is
      // connected to an in-process resolver, never global fetch or a provider.
      op.stages[c].result={assetId:result.assetId,sha256:result.sha256,resultSha256:result.resultSha256,
        url:internalOrigin+'/'+roomId+'/'+operationId+'/'+c};
    }
    return op;
  }
  async function providerAsset(roomId,op,channel) {
    const stage=op.stages[channel],result=stage.result,record=await readAsset(result.assetId,result.sha256);
    const sourceSha256=channel==='music'?op.permit.source.music.contextSha256:op.permit.source.video.referenceSha256;
    if(cueDigest(record.binding??null)!==cueDigest(operationBinding(roomId,op,channel))||
      record.provenance?.kind!=='provider'||record.provenance.requestId!==stage.requestId||
      record.provenance.resultSha256!==result.resultSha256||record.provenance.sourceSha256!==sourceSha256||
      record.provenance.operationId!==op.operationId)fail('PRIVATE_PROVIDER_BINDING_MISMATCH');
    return record;
  }
  async function privateResponse(input) {
    const url=new URL(input);
    if(url.origin!==internalOrigin||url.search||url.hash)fail('PRIVATE_MEDIA_RESOLVER_ONLY');
    const parts=url.pathname.slice(1).split('/');
    if(parts.length!==3||!['music','video'].includes(parts[2]))fail('PRIVATE_MEDIA_RESOLVER_ONLY');
    const [roomId,operationId,channel]=parts,op=await operation({roomId,operationId});
    const record=await providerAsset(roomId,op,channel);
    return new Response(record.bytes,{headers:{'content-length':String(record.bytes.length)}});
  }
  // Always verify physical bytes again when evidence asks for a private save.
  const checkedStore={
    read:assetId=>readAsset(assetId),
    async save(input){
      if(!id(input.id)||!(input.bytes instanceof Uint8Array))fail('PRIVATE_SAVE_REQUIRED');
      const saved=await assetStore.save(input),verified=await readAsset(input.id,hash(input.bytes));
      if(saved?.assetId!==input.id||cueDigest(verified.binding??null)!==cueDigest(input.binding??null))fail('PRIVATE_SAVE_BINDING_MISMATCH');
      return verified;
    },
    async verifySaved(input){
      const saved=await readAsset(input.asset.assetId,input.asset.sha256);
      if(cueDigest(saved.binding??null)!==cueDigest(input.binding))fail('PRIVATE_SAVE_BINDING_MISMATCH');
      const proof=await assetStore.verifySaved(input);
      if(proof?.privateSaved!==true||proof.checksumVerified!==true)fail('PRIVATE_SAVE_PROOF_REQUIRED');
      return proof;
    },
  };
  async function getPipeline() {
    active();if(pipeline)return pipeline;if(creating)return creating;
    creating=(async()=>{
      let inspectors=native;
      if(!inspectors){runtimeHandle=await createPortableNativeRuntime(runtime);inspectors=runtimeHandle.native;}
      if(closed){await runtimeHandle?.close();fail('CLOUD_WORKER_CLOSED');}
      pipeline=createPrototypePipeline({readOperation:operation,readCurrent:currentSource,store:checkedStore,
        readGenerationSource,native:inspectors,readVisualPlan,readSavedRecord,readExactReview,fetchImpl:privateResponse});
      return pipeline;
    })().finally(()=>{creating=null;});
    return creating;
  }
  async function runInspection({roomId,operation:provided,operationId=provided?.operationId}={}) {
    active();const op=await operation({roomId,operationId}),fingerprint=generationFingerprint(op);
    // Browser-provided stages, QC, provenance and permit are never consulted.
    const previous=completed.get(operationId);
    if(previous&&previous!==fingerprint)fail('AUTHORITATIVE_OPERATION_CHANGED');
    await Promise.all(['music','video'].map(channel=>providerAsset(roomId,op,channel)));
    const service=await getPipeline(),evidence=await service.inspectGeneration({roomId,operation:op});
    // Cached native measurements never replace physical private-asset checks.
    await Promise.all(['music','video'].map(channel=>checkedStore.verifySaved(evidence[channel])));
    await Promise.all(evidence.video.clips.map(clip=>readAsset(clip.assetId,clip.sha256)));
    const render=await service.readRender({cue:{cueId:op.plan.common.cueId,operationId:op.operationId}});
    await readAsset(render.assetId,render.receipt.renderedSha256);
    if(fingerprint!==generationFingerprint(await operation({roomId,operationId})))fail('AUTHORITATIVE_OPERATION_CHANGED');
    buildVerifiedCue({roomId,operation:op,evidence});
    if(persistRenderRecords)await renderRecords.save({roomId,operationId:op.operationId,cueId:op.plan.common.cueId,
      binding:operationBinding(roomId,op,'music'),source:readGenerationSource?await readGenerationSource({roomId,operation:op}):await currentSource(roomId),render,evidenceSha256:cueDigest(evidence)});
    completed.set(operationId,fingerprint);return evidence;
  }
  async function inspectGeneration(input) {
    if(inspections.size>=2)throw new PortableWorkerHold('NATIVE_QC_BUSY');
    const work=runInspection(input);inspections.add(work);
    try{return await work;}
    catch(error){const held=new PortableWorkerHold(safeReason(error));Object.defineProperty(held,'cause',{value:error});throw held;}
    finally{inspections.delete(work);}
  }
  const pairIdentity=current=>Object.fromEntries(['clipId','sha256','contextSha256','playbackRevision'].map(k=>[k,current[k]]));
  // The join PCM does not depend on the playback revision: the DSP records it
  // only in the receipt. A join prepared at the base revision serves the same
  // CURRENT bytes at another revision through its own immutable record, which
  // points at the same verified render with the receipt's revision rebound.
  async function rebindPreparedPair({roomId,candidate,pairCurrent}){
    let base;
    try{base=await playbackRenderRecords.read({roomId,cue:candidate,pairCurrent:{...pairCurrent,playbackRevision:PAIR_BASE_REVISION}});}catch{return null;}
    const receipt=base.render.receipt;
    if(receipt.currentPlaybackRevision!==PAIR_BASE_REVISION||receipt.currentSha256!==pairCurrent.sha256)return null;
    await confirmPlaybackAsset(base.render.assetId,receipt.renderedSha256);
    await playbackRenderRecords.save({roomId,operationId:base.operationId,cueId:base.cueId,binding:base.binding,
      source:{...structuredClone(base.source),playback:{...base.source.playback,revision:pairCurrent.playbackRevision}},
      render:{assetId:base.render.assetId,receipt:{...structuredClone(receipt),currentPlaybackRevision:pairCurrent.playbackRevision}},
      evidenceSha256:base.evidenceSha256,pairCurrent});
    return playbackRenderRecords.read({roomId,cue:candidate,pairCurrent});
  }
  // Immutable CPU preparation can finish before finite source audio starts.
  // Archived source data grants no live playback authority; inspectJoin and
  // the coordinator must still bind it to the freshly observed CURRENT.
  async function measuredPair({roomId,candidate,current,pairCurrent}) {
    // An already saved join needs no parent/incoming download.
    try{const previous=await playbackRenderRecords.read({roomId,cue:candidate,pairCurrent});
      await Promise.all([confirmPlaybackAsset(previous.render.assetId,previous.render.receipt.renderedSha256),
        confirmPlaybackAsset(current.audioAssetId,current.music.sha256),
        confirmPlaybackAsset(candidate.music.asset.assetId,candidate.music.asset.sha256)]);
      return previous.render.receipt;}catch{}
    const parent=await readPlaybackAsset(current.audioAssetId,current.music.sha256),incoming=await readPlaybackAsset(candidate.music.asset.assetId,candidate.music.asset.sha256);
    let inspectors=native;if(!inspectors){await getPipeline();inspectors=runtimeHandle?.native;}
    if(typeof inspectors?.inspectJoin!=='function')return null;
    const inputDigest=await digest({kind:'current-incoming-nonoverlap-measurement-v1',pairCurrent,incomingSha256:incoming.sha256});
    const measured=await inspectors.inspectJoin({bytes:incoming.bytes,sourceBytes:parent.bytes,inputDigest,playbackRevision:pairCurrent.playbackRevision});
    const receipt=measured?.receipt;
    if(measured?.method!==QC_VERSION||measured.inputDigest!==inputDigest||!measuredJoinContract(receipt)||receipt.passed!==true||
      receipt.currentSha256!==parent.sha256||receipt.incomingSha256!==incoming.sha256||
      !(measured.renderBytes instanceof Uint8Array)||hash(measured.renderBytes)!==receipt.renderedSha256)return null;
    // Scoped by the candidate operation and incoming bytes, not cueId alone.
    const assetId='pair-render-'+cueDigest({roomId,cueId:candidate.cueId,operationId:candidate.operationId,
      incomingSha256:incoming.sha256,pairCurrent}).slice(0,48);
    await checkedStore.save({id:assetId,bytes:measured.renderBytes,contentType:'audio/wav',binding:candidate.music.binding,
      provenance:{kind:'verified-pair-render',actualGenerationThisRun:false}});
    await playbackRenderRecords.save({roomId,operationId:candidate.operationId,cueId:candidate.cueId,
      binding:candidate.music.binding,source:current,render:{assetId,receipt},evidenceSha256:candidate.evidenceSha256,pairCurrent});
    return receipt;
  }
  const api={
    inspectGeneration,
    async preparePlaybackCandidate({roomId,candidate}){
      active();const record=await playbackRenderRecords.read({roomId,cue:candidate});
      const assets=await Promise.all([readPlaybackAsset(record.render.assetId,record.render.receipt.renderedSha256),
        readPlaybackAsset(record.source.audioAssetId,record.source.music.sha256),
        readPlaybackAsset(candidate.music.asset.assetId,record.render.receipt.incomingSha256),
        ...candidate.video.clips.map(clip=>readPlaybackAsset(clip.assetId,clip.sha256))]);
      // A separate endpoint render gives preparation the full finite parent
      // window instead of a previously chosen overlap frontier. It is measured
      // from the same physical bytes, never a shifted old render or clock edit.
      let endpoint=null;
      if(record.source.playback.revision===0){
        const pairCurrent=pairIdentity(selector(record.source));
        const receipt=await measuredPair({roomId,candidate,current:record.source,pairCurrent});
        if(receipt){const pair=await playbackRenderRecords.read({roomId,cue:candidate,pairCurrent});
          endpoint=await readPlaybackAsset(pair.render.assetId,receipt.renderedSha256);}
      }
      active();return {verified:true,assets:[assets[0],...(endpoint?[endpoint]:[]),...assets.slice(3)].map(a=>({assetId:a.assetId,sha256:a.sha256,
        byteLength:a.byteLength,mimeType:a.contentType}))};
    },
    async preparePlaybackPair({roomId,candidate,source,playbackRevision}){
      active();if(!persistRenderRecords||source?.playback?.actual!==false||!Number.isSafeInteger(playbackRevision)||
        playbackRevision<1||playbackRevision>2)fail('PLAYBACK_PAIR_PREPARATION_REQUIRED');
      const current={...structuredClone(source),playback:{...source.playback,revision:playbackRevision}},pairCurrent=pairIdentity(selector(current));
      const receipt=await measuredPair({roomId,candidate,current,pairCurrent});
      if(!receipt)return null;
      const record=await playbackRenderRecords.read({roomId,cue:candidate,pairCurrent}),asset=await readPlaybackAsset(record.render.assetId,receipt.renderedSha256);
      active();return {assetId:asset.assetId,sha256:asset.sha256,byteLength:asset.byteLength,mimeType:asset.contentType};
    },
    async readCurrent(roomId){active();return selector(await currentSource(roomId));},
    // measure:false is the reservation path: an unprepared join returns null
    // (HOLD) instead of a native render inside the finite current Cue.
    async inspectJoin(input,{measure=true}={}){
      active();
      if(persistRenderRecords){
        try{
          // This is immutable measured data, not a live CURRENT grant. Use the
          // caller's freshly observed identity to retrieve its exact pair; the
          // coordinator still freshly checks CURRENT after inspection and the
          // atomic reservation/prepare/commit guards remain authoritative.
          const pairCurrent=pairIdentity(input.current);
          let preparedPair;
          try{preparedPair=await playbackRenderRecords.read({roomId:input.roomId,cue:input.candidate,pairCurrent});}catch{}
          if(!preparedPair&&pairCurrent.playbackRevision!==PAIR_BASE_REVISION)
            preparedPair=await rebindPreparedPair({roomId:input.roomId,candidate:input.candidate,pairCurrent});
          if(preparedPair){
            await Promise.all([confirmPlaybackAsset(preparedPair.render.assetId,preparedPair.render.receipt.renderedSha256),
              confirmPlaybackAsset(preparedPair.source.audioAssetId,preparedPair.source.music.sha256),
              confirmPlaybackAsset(input.candidate.music.asset.assetId,preparedPair.render.receipt.incomingSha256)]);
            return preparedPair.render.receipt;
          }
          const record=await playbackRenderRecords.read({roomId:input.roomId,cue:input.candidate}),source=selector(record.source);
          if(!['clipId','sha256','contextSha256','playbackRevision'].some(key=>source[key]!==input.current[key])){
            await confirmPlaybackAsset(record.render.assetId,record.render.receipt.renderedSha256);
            await confirmPlaybackAsset(record.source.audioAssetId,record.source.music.sha256);
            await confirmPlaybackAsset(input.candidate.music.asset.assetId,record.render.receipt.incomingSha256);
            return record.render.receipt;
          }
          if(!measure)return null;
          // Generation lineage is not a receipt for the CURRENT/incoming pair.
          // Measure/save a separate immutable render bound to the current SHA
          // and playback revision; retain the original generation render.
          const current=await currentSource(input.roomId);
          if(cueDigest(pairCurrent)!==cueDigest(Object.fromEntries(Object.keys(pairCurrent).map(k=>[k,selector(current)[k]]))))return null;
          const receipt=await measuredPair({roomId:input.roomId,candidate:input.candidate,current,pairCurrent});
          if(!receipt)return null;
          const latest=selector(await currentSource(input.roomId));
          if(cueDigest(pairCurrent)!==cueDigest(Object.fromEntries(Object.keys(pairCurrent).map(k=>[k,latest[k]]))))return null;
          return receipt;
        }catch{return null;}
      }
      const service=await getPipeline(),receipt=await service.inspectJoin(input);
      if(!receipt)return null;
      try {
        const render=await service.readRender({cue:input.candidate});
        await readPlaybackAsset(render.assetId,receipt.renderedSha256);
        await readPlaybackAsset(input.candidate.music.asset.assetId,receipt.incomingSha256);
      } catch {return null;}
      return receipt;
    },
    async readRender(input){
      active();
      if(persistRenderRecords){const plan=input.plan,pairCurrent=plan?.transition?.measuredCutVerified?{
        clipId:plan.currentClipId,sha256:plan.currentSha256,contextSha256:plan.currentContextSha256,playbackRevision:plan.currentPlaybackRevision}:null;
        return (await playbackRenderRecords.read({roomId:input.roomId,cue:input.cue,...(pairCurrent?{pairCurrent}:{})})).render;}
      return(await getPipeline()).readRender(input);
    },
    async resolveRender(input){
      active();let source;
      // The resolver's fresh current read also supplies the private artifact
      // alias. A separate earlier current read only repeated network work and
      // could map an older parent than the one actually being verified.
      const resolve=createRenderResolver({readCurrent:async room=>{source=await currentSource(room);return selector(source);},readRender:api.readRender,
        readArtifact:assetId=>readPlaybackAsset(assetId===source.music.clipId?source.audioAssetId:assetId)});
      return resolve(input);
    },
    async describeRender(input){
      const rendered=await api.resolveRender(input),record=await api.readRender(input),asset=await readPlaybackAsset(record.assetId,rendered.renderedFileSha256);
      const {pcm,...metadata}=rendered;
      return {...metadata,assetId:asset.assetId,sha256:asset.sha256,byteLength:asset.byteLength,mimeType:'audio/wav',
        ...(enableClipRelativeTimeline===true?{timelineSpace:'clip-relative-v1'}:{})};
    },
    async describeReservedRender(input){
      active();if(!persistRenderRecords)fail('SAVED_MEDIA_REQUIRED');
      const plan=input.plan,pairCurrent=plan?.transition?.measuredCutVerified?{
        clipId:plan.currentClipId,sha256:plan.currentSha256,contextSha256:plan.currentContextSha256,playbackRevision:plan.currentPlaybackRevision}:null;
      const proof=await playbackRenderRecords.read({roomId:input.roomId,cue:input.cue,...(pairCurrent?{pairCurrent}:{})}),source=proof.source;
      // This describes immutable bytes, not permission to install/play them.
      // The owner manifest boundary freshly checks the exact reservation before
      // and after this call. The output's live prepare/ACK guards and worklet
      // editable-frontier checks still authorize actual playback. Verify the
      // saved render against its exact physical parent at its original frame0;
      // downloading it must not reclassify an already reserved live frontier.
      const resolve=createRenderResolver({readCurrent:async()=>selector({...source,
        playback:{...source.playback,playedUntilFrame:0}}),readRender:api.readRender,
        readArtifact:assetId=>readPlaybackAsset(assetId===source.music.clipId?source.audioAssetId:assetId)});
      const rendered=await resolve(input),asset=await readPlaybackAsset(proof.render.assetId,rendered.renderedFileSha256);
      const {pcm,...metadata}=rendered;
      return {...metadata,assetId:asset.assetId,sha256:asset.sha256,byteLength:asset.byteLength,mimeType:'audio/wav',
        ...(enableClipRelativeTimeline===true?{timelineSpace:'clip-relative-v1'}:{})};
    },
    async prepareBootstrap({audioAssetId,audioSha256,referenceAssetId,referenceSha256,...configuration}={}){
      active();if(!checksum(audioSha256)||!checksum(referenceSha256))fail('PRIVATE_ASSET_ID_AND_SHA_REQUIRED');
      const [audio,reference]=await Promise.all([readAsset(audioAssetId,audioSha256),readAsset(referenceAssetId,referenceSha256)]);
      let inspect=inspectBootstrap;
      if(!inspect){await getPipeline();inspect=runtimeHandle?.inspectBootstrap;}
      if(typeof inspect!=='function')fail('BOOTSTRAP_INSPECTOR_REQUIRED');
      const prepared=await prepareBootstrap({...configuration,audioBytes:audio.bytes,referenceBytes:reference.bytes,inspect});
      return saveBootstrap({prepared,store:checkedStore});
    },
    processJob(job={}) {
      // Queue payloads contain identifiers only, with no capability or verdict.
      if(Object.keys(job).some(k=>!['roomId','operationId'].includes(k))||!id(job.roomId)||!id(job.operationId))
        return Promise.resolve({status:'HOLD',reasons:['CLOUD_JOB_IDS_ONLY'],evidence:null});
      const key=job.roomId+'/'+job.operationId;
      if(pending.has(key))return pending.get(key);
      const work=inspectGeneration(job).then(evidence=>({status:'QC_READY',roomId:job.roomId,operationId:job.operationId,evidence}))
        .catch(error=>({status:'HOLD',roomId:job.roomId,operationId:job.operationId,
          reasons:[safeReason(error)],evidence:null}))
        .finally(()=>pending.delete(key));
      pending.set(key,work);return work;
    },
    async close(){closed=true;await Promise.allSettled([...pending.values(),...inspections]);await creating?.catch(()=>{});
      pipeline?.close();await runtimeHandle?.close();completed.clear();},
  };
  return api;
}
