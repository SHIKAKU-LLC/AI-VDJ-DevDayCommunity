import {AsyncLocalStorage} from 'node:async_hooks';
import {diagnosticReasons} from '../generation/diagnostics.mjs';
import {randomUUID} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {createProductionCloudIo} from './production-io.mjs';
import {createPortableNativeRuntime} from './native-runtime.mjs';
import {createPortableCloudWorker,PAIR_BASE_REVISION} from './portable-worker.mjs';
import {createPrivateMediaIngestion} from './private-ingestion.mjs';
import {createOperatorPlanStore} from '../jobs/operator-store.mjs';
import {validateExecutionAuthorization,refreshExecutionEvidence} from './execution-authorization.mjs';
import {createOperatorMedia} from './operator-media.mjs';
import {createOwnerOperator,countOperatorTrialCredits} from './owner-operator.mjs';
import {createProductionOperatorAdapters} from './production-operator-adapters.mjs';
import {createBootstrapPreparationReader} from './generation-preparation.mjs';
import {isBootstrapPreparationSource} from '../generation/bootstrap-source-contract.mjs';
import {resolveOperatorConnectionBinding,resolveOperatorResultConnectionBinding} from './operator-connections.mjs';
import {createProviderResultReconciler} from './result-reconciliation.mjs';
import {createReconciledMediaInspector} from './reconciled-media-inspector.mjs';
import {createProductionVisualPlan} from './visual-plan.mjs';
import {createProductionBootstrapAuthority} from './bootstrap-authority.mjs';
import {createProductionPlayerMaterial} from './player-material.mjs';
import {createPlaybackAssetSnapshots} from './playback-asset-snapshots.mjs';
import {createPlayerObserverStore} from '../jobs/player-observer-store.mjs';
import {createPlayerObserverRegistry} from '../jobs/player-observer-registry.mjs';
import {createTypedCloudHostComposition} from '../jobs/typed-host-composition.mjs';
import {createImmutableSourceStartReceiptStore} from '../jobs/source-start-receipts.mjs';
import {createDispatchAuthority} from '../jobs/dispatch-authority.mjs';
import {createCueCoordinator} from '../generation/cue-coordinator.mjs';
import {createGenerationProvider,createReadOnlyGenerationProvider} from '../generation/provider.mjs';
import {createCloudGenerationJobs} from '../jobs/generation-jobs.mjs';
import {createCloudRecoveryRunner} from '../jobs/recovery-runner.mjs';
import {createDurableSchedulerRepository, createDurableCloudScheduler} from '../jobs/durable-scheduler.mjs';
import {createCloudFirstHandler} from '../jobs/cloud-first-handler.mjs';
import {createCloudRoomProjection} from '../jobs/room-projection.mjs';
import {createCloudMediaHandler} from '../jobs/http.mjs';
import {EXISTING_REPOSITORY_SELECTS} from '../jobs/repository-statements.mjs';
import {createPairPreparation} from './pair-preparation.mjs';
import {cueDigest,cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';

const fail = code => {throw new DispatchError(code);};
const scopeOf = ({roomId, sessionId, controlRevision}) => ({roomId, sessionId, controlRevision});
const exactKeys=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&
  Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const operatorId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
// Fresh balance/price evidence and expiring delivery URLs are applied only at
// claim time. The durable review freezes the remaining permit identity.
const permitIdentity=({assets,quote,balance,...identity})=>identity;
const reply = (body, status = 200) => Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function emptyBody(request){
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')fail('STARTUP_IDS_FIXED');
  const reader=request.body?.getReader();let text='',size=0;
  if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;
    if(size>4096)fail('STARTUP_IDS_FIXED');text+=new TextDecoder('utf-8',{fatal:true}).decode(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  if(text.trim()!=='{}')fail('STARTUP_IDS_FIXED');
}

// Concrete native Node broker: browser owner requests, private PG/Storage,
// measured bootstrap/observer/material, provider ingestion/QC, and durable lease
// loop share this host. There is no inbound worker credential protocol to invent:
// native CPU work runs inside the already-authorized broker process. All loaders,
// connections, native tools and timers remain dormant until explicit activation.
// Show mode: the owner's output page is the trusted playback clock. Reported
// frontiers stay usable for this long so serialized Edge I/O delays cannot
// starve reservation; the worklet's atomic edit check remains the real guard.
const SHOW_FRONTIER_AGE_MS=30000;
export function createProductionNativeHost({enabled=false, roomId, projectURL, origin='https://ai-vdj.vercel.app',
  createPool, withPlatformHeaders,edgeTransport, withOwnerAuthorization: externalOwner, credentialForOperation,
  bootstrapConfiguration, acceptedVisualEdit, verifyExactReview, runtime={}, fetchImpl=globalThis.fetch,
  loadSDK=()=>import('../../snapshot/node_modules/@fal-ai/client/src/index.js'), loadNative=createPortableNativeRuntime,
  workerId='worker-'+randomUUID(),deferScheduler=false,runBackground=callback=>callback(),preparePairsAhead=true, now=Date.now, fallback, operatorConfiguration={},onDiagnostic=()=>{},showMode=false,serverManaged=false}={}) {
  if(typeof serverManaged!=='boolean')fail('PRODUCTION_HOST_CONFIGURATION_REQUIRED');
  if(typeof showMode!=='boolean'||typeof preparePairsAhead!=='boolean'||typeof runBackground!=='function'||typeof deferScheduler!=='boolean'||typeof enabled!=='boolean'||typeof externalOwner!=='function'||!edgeTransport&&typeof withPlatformHeaders!=='function')fail('PRODUCTION_HOST_CONFIGURATION_REQUIRED');
  if(operatorConfiguration.enabled===true&&!bootstrapConfiguration)bootstrapConfiguration={};
  const hasOperatorResolver=operatorConfiguration.enabled===true&&(typeof operatorConfiguration.connections?.forOperation==='function'||operatorConfiguration.adapters?.enabled===true);
  if(enabled&&((typeof credentialForOperation!=='function'&&!hasOperatorResolver)||!edgeTransport&&typeof createPool!=='function'||!bootstrapConfiguration))fail('PRODUCTION_HOST_ACTIVATION_CONFIGURATION_REQUIRED');
  let operatorConnections=operatorConfiguration.connections,readOperatorConnectionBinding,operatorRuntime,configuringOperator=false,
    activeOperatorRequests=0;let executionConsent=!deferScheduler,schedulerRunning=false;
  const actorContext=new AsyncLocalStorage(),leaseContext=new AsyncLocalStorage();let closed=false,nativePromise,typedHost,scheduler,bootstrapReady=false;
  const active=()=>{if(!enabled||closed)fail('PRODUCTION_HOST_NOT_ACTIVATED');};
  const withOwner=(scope,invoke)=>{
    const actor=actorContext.getStore();
    return actor?.ownerCapability ? invoke({...scope,ownerCapability:actor.ownerCapability}) : externalOwner(scope,invoke);
  };
  const io=createProductionCloudIo({enabled,roomId,projectURL,createPool,withPlatformHeaders,edgeTransport,withOwnerAuthorization:withOwner,fetchImpl,now});
  const {repository,repositoryPorts:ports,privateStore}=io;
  const playbackAssets=createPlaybackAssetSnapshots({assetStore:privateStore.assetStore});
  const existingRoomHandler=typeof fallback==='function'?fallback:async request=>{
    active();const url=new URL(request.url),headers=new Headers(request.headers);
    headers.delete('host');headers.delete('content-length');
    const bytes=['GET','HEAD'].includes(request.method)?null:new Uint8Array(await request.arrayBuffer());
    if(bytes&&bytes.length>65536)fail('BODY_TOO_LARGE');
    return fetchImpl(projectURL+'/functions/v1/ai-vdj-room'+url.pathname+url.search,{method:request.method,headers,
      ...(bytes?{body:bytes}:{}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(8000)});
  };
  const authorizeOwner=async input=>{
    active();if(input.roomId!==roomId)return false;
    try{return (await repository.request('cueState',roomId,input.ownerCapability,{})).roomId===roomId;}catch{return false;}
  };
  const getNative=()=>{active();return nativePromise??=Promise.resolve().then(()=>loadNative(runtime));};
  const native=Object.fromEntries(['inspectAudio','inspectVideo','inspectJoin'].map(key=>[key,async input=>(await getNative()).native[key](input)]));
  const ingestion=createPrivateMediaIngestion({enabled,assetStore:privateStore.assetStore,receiptStore:privateStore.receiptStore,
    readOperation:ports.readAuthoritativeOperation,readSourceEvidence:privateStore.readSourceEvidence,fetchImpl});
  const visualPlan=createProductionVisualPlan({enabled,readOperation:ingestion.readOperationMetadata,assetStore:privateStore.assetStore,
    inspectVideo:native.inspectVideo,verifyExactReview,readScope:input=>readOperatorScope(input),now});
  const worker=createPortableCloudWorker({enabled,assetStore:privateStore.assetStore,playbackAssetStore:playbackAssets,readOperation:ingestion.readOperationMetadata,
    readCurrent:room=>typedHost.readCurrentSource({roomId:room}),readVisualPlan:visualPlan.readVisualPlan,readSavedRecord:visualPlan.readSavedRecord,
    readGenerationSource:({roomId,operation})=>isBootstrapPreparationSource(operation.permit.source)?readPreparationSource({roomId}):typedHost.readCurrentSource({roomId}),
    readExactReview:verifyExactReview,native,inspectBootstrap:async bytes=>(await getNative()).inspectBootstrap(bytes),
    enableClipRelativeTimeline:true,persistRenderRecords:true});
  const bootstrap=createProductionBootstrapAuthority({enabled,roomId,readScope:ports.readScope,worker,assetStore:privateStore.assetStore,
    sourceStore:privateStore.sourceStore,configuration:bootstrapConfiguration,now});
  const readBoundPlayback=input=>withOwner(input,async context=>{
    const value=await repository.request('cueState',roomId,context.ownerCapability,{});
    if(input.roomId!==roomId||value?.roomId!==roomId||!Array.isArray(value.cues)||value.cues.length>100||
      typeof value.pending!=='boolean'||typeof value.stopped!=='boolean')fail('AUTHORITATIVE_PLAYBACK_STATE_REQUIRED');
    return structuredClone(value);
  });
  const readPreparationSource=createBootstrapPreparationReader({roomId,readScope:ports.readScope,
    // Signing/admission physically rereads all private assets below. Runtime
    // checkpoints reuse only that host's immutable, hash-verified snapshot;
    // the preparation reader still brackets it with fresh owner/scope/Stop.
    readPlaybackState:readBoundPlayback,readBootstrapAuthority:bootstrap.readPreparedAuthority,now});
  // These readers are used only inside observer/material operations, whose
  // outer before/after scope checks already bracket the snapshot. Avoid nesting
  // a second pair of scope reads around every individual field. Every query
  // still uses the authenticated repository and its existing DB scope guards.
  const observerStore=createPlayerObserverStore({query:repository.privateStateQuery,withOwnerAuthorization:withOwner});
  const sourceStartReceiptStore=createImmutableSourceStartReceiptStore({
    readRecord:({reference})=>observerStore.readSourceStartReceipt(reference),
    putObservedIfAbsent:({reference,record})=>observerStore.putSourceStartReceipt(reference,record),
    putIfAbsent:({reference,record})=>observerStore.putSourceStartReceipt(reference,record)});
  const playerPorts={...ports,readPlaybackSnapshot:observerStore.readPlaybackSnapshot,
    readPlaybackState:readBoundPlayback,
    readRoomRuntime:async input=>{
      if(input.roomId!==roomId)fail('ROOM_JOB_SCOPE_CHANGED');
      const result=await repository.query(EXISTING_REPOSITORY_SELECTS.runtime,[roomId]),rows=result?.rows;
      if(!Array.isArray(rows)||rows.length>1||rows.length&&(!rows[0].runtime||typeof rows[0].runtime!=='object'||
        !Array.isArray(rows[0].runtime.acks)||rows[0].runtime.acks.length>100))fail('AUTHORITATIVE_ROOM_RUNTIME_REQUIRED');
      return rows.length?structuredClone(rows[0].runtime):null;
    }};
  const material=createProductionPlayerMaterial({enabled,roomId,bootstrapAuthority:bootstrap,repositoryPorts:playerPorts,assetStore:playbackAssets,now});
  const observer=createPlayerObserverRegistry({enabled,roomId,origin,readScope:ports.readScope,readPlaybackState:playerPorts.readPlaybackState,
    authorizeOwner,readVerifiedMaterial:material.readObserverMaterial,readVerifiedSourceSnapshot:material.readSourceSnapshot,
    now,onHold:reason=>onDiagnostic({event:'PLAYER_OBSERVER_HOLD',reason}),
    onCollectionState:reason=>onDiagnostic({event:'PLAYER_OBSERVER_COLLECTION',reason}),
    store:observerStore,...(showMode?{showMode:true,maximumAgeMs:SHOW_FRONTIER_AGE_MS}:{})});
  const readPlaybackSnapshot=async input=>observerStore.readPlaybackSnapshot(verifiedNativeBootstrapScope??scopeOf(await ports.readScope(input)));
  typedHost=createTypedCloudHostComposition({enabled,roomId,origin,allowStoppedRestart:true,cachePreparedMaterial:true,query:repository.query,
    ...(showMode?{maximumAgeMs:SHOW_FRONTIER_AGE_MS,showMode:true}:{}),
    onHold:reason=>onDiagnostic({event:'SOURCE_START_HOLD',reason}),
    hostGenerationRead:async input=>ports.readAuthoritativeOperation && (input.action==='cueState'?playerPorts.readPlaybackState({roomId:input.roomId}):
      ports.readAuthoritativeOperation({roomId:input.roomId,operationId:input.operationId})),
    authorizeOwner,privateStore:{...privateStore,sourceStartReceiptStore,assetStore:{...privateStore.assetStore,
      read:bootstrap.readPlaybackAsset,verifySaved:bootstrap.verifyPlaybackSaved}},now,
    authorities:{readStartAuthority:input=>input.expiresAtMs===undefined?bootstrap.readPreparedAuthority(input):bootstrap.readAdmittedAuthority(input),
      readPlaybackSnapshot,
      readSourceStartState:observer.readSourceStartState,
      readAcknowledgedSourceFrontier:observer.readSourceFrontier,
      readGraphAuthority:observer.readGraphAuthority,readPriorStopReceipt:observer.readPriorStopReceipt,
      readSourceFrontier:observer.readSourceFrontier,readSelectedTarget:observer.readSelectedTarget,readCurrentFrontier:observer.readCurrentFrontier,
      verifyContinuation:async ({scope,source,firstPlan})=>{
        // Replays can keep several operations under one cueId; only the exact
        // planned generation/incoming bytes/control version is the continuation.
        const playback=await ports.readPlaybackState(scope),matches=playback.cues.filter(c=>c.cueId===firstPlan.cueId&&
          c.generationId===firstPlan.generationId&&c.music?.asset?.sha256===firstPlan.incomingSha256&&c.controlVersion===firstPlan.controlVersion);
        if(matches.length!==1)fail('MEASURED_FIRST_CONTINUATION_REQUIRED');const cue=matches[0];
        const receipt=await worker.inspectJoin({roomId,current:{clipId:source.music.clipId,sha256:source.music.sha256,
          contextSha256:source.music.contextSha256,profile:source.music.profile,playbackRevision:source.playback.revision,playedUntilFrame:0},candidate:cue});
        if(!receipt||receipt.renderedSha256!==firstPlan.transition?.renderedSha256)fail('MEASURED_FIRST_CONTINUATION_REQUIRED');
        return {...scope,kind:'verified-first-continuation-v1',valid:true,planSha256:firstPlan.planSha256,renderedSha256:receipt.renderedSha256,
          sourceSha256:source.music.sha256,contextSha256:source.music.contextSha256,evidenceSha256:cueDigest(receipt)};
      }}});
  // Dispatch facts already brackets these rows with fresh scope and Stop reads.
  // Keep every facts/source/lease checkpoint; avoid nesting another scope pair
  // inside this single immutable permit metadata lookup.
  const readDispatchPermit=async input=>{
    if(input.roomId!==roomId||!operatorId(input.permitId))fail('PERMIT_REFERENCE_REQUIRED');
    const {rows}=await repository.query(EXISTING_REPOSITORY_SELECTS.permit,[input.permitId,roomId]);
    const p=rows?.[0];
    if(rows?.length!==1||p.roomId!==roomId||p.permitId!==input.permitId||typeof p.revoked!=='boolean'||
      !Number.isFinite(Number(p.expiresAtMs))||!p.permitDocument||typeof p.permitDocument!=='object'||Array.isArray(p.permitDocument))fail('AUTHORITATIVE_PERMIT_SCOPE_REQUIRED');
    return {...scopeOf(p),permitId:p.permitId,revoked:p.revoked,expiresAtMs:Number(p.expiresAtMs),
      permitSha256:cueDigest({...p.permitDocument,permitId:p.permitId})};
  };
  const baseGuard=createDispatchAuthority({enabled,repository,readScope:ports.readScope,readPermitScope:readDispatchPermit,
    readCurrentSource:typedHost.readCurrentSource,readPreparationSource,mediaHost:new URL(projectURL).hostname,now});
  const authorityGuard=Object.freeze({assert:async input=>{
    const lease=leaseContext.getStore();if(lease){if(lease.signal.aborted)fail('SCHEDULER_FENCE_HOLD');await lease.assertClaim();}
    const proof=await baseGuard.assert(input);if(lease){await lease.assertClaim();if(lease.signal.aborted)fail('SCHEDULER_FENCE_HOLD');}return proof;
  }});
  // Joins between published Cues are rendered ahead in the background, never
  // inside a reservation (2026-10-17: one A -> B join took ~29s of A's 24s).
  // Each reservation, publication and preload re-checks for missing joins.
  const pairPreparation=createPairPreparation({enabled:enabled&&preparePairsAhead,now,
    readCues:async()=>(await readPlaybackSnapshot({roomId})).playback.cues,
    prepareSource:async parent=>{const prepared=await typedHost.preparePublishedSource({roomId,operationId:parent.operationId});
      if(prepared.source?.playback?.actual!==false)fail('PLAYBACK_PREFLIGHT_CHANGED');return prepared.source;},
    preverifySource:async(parent,source)=>{const started=now();await typedHost.preverifyPublishedSource({roomId,cue:parent,source});
      try{onDiagnostic({event:'PLAYBACK_PREVERIFIED',reason:parent.cueId.slice(0,24)+':'+(now()-started)+'ms'});}catch{}},
    preparePair:({candidate,source})=>worker.preparePlaybackPair({roomId,candidate,source,playbackRevision:PAIR_BASE_REVISION}),
    runBackground:callback=>actorContext.run(null,()=>runBackground(callback)),onDiagnostic});
  const coordinator=createCueCoordinator({enabled,repository,requireAuthority:true,authorityGuard,now,
    inspectGeneration:worker.inspectGeneration,readCurrent:worker.readCurrent,
    // Without background preparation the reservation keeps the former inline render.
    inspectJoin:input=>{pairPreparation.schedule();return worker.inspectJoin(input,{measure:!preparePairsAhead});},
    onTiming:reason=>onDiagnostic({event:'CUE_TIMING',reason}),showMode});
  let sdk;
  const provider=Object.fromEntries(['submit','status','result'].map(key=>[key,async input=>{
    active();sdk??=await loadSDK();const factory=(sdk.default??sdk).createFalClient;
    return createGenerationProvider({createFalClient:factory,fetchImpl,onDiagnostic})[key](input);
  }]));
  const jobs=createCloudGenerationJobs({enabled,repository,provider,requireAuthority:true,authorityGuard,coordinator,onDiagnostic,
    onPublished:()=>pairPreparation.schedule(),
    mediaHost:new URL(projectURL).hostname,now,credentialForOperation:async input=>{
      if(operatorConfiguration.enabled===true&&typeof operatorConnections?.forOperation==='function'){
        const binding=await readOperatorConnectionBinding(input);
        return operatorConnections.forOperation({...scopeOf(binding),operationId:input.operationId,connectionId:binding.connectionId});
      }
      return credentialForOperation(input);
    },
    prepareMedia:async input=>{
      let phase='ingestion';
      try{await ingestion.prepareMedia(input);phase='operator-visual-edit';
        const edit=await (typeof acceptedVisualEdit==='function'?acceptedVisualEdit(input):readOperatorVisualEdit(input));
        phase='visual-edit-save';if(edit)await visualPlan.saveAcceptedEdit({...edit,...input});
      }catch(error){try{onDiagnostic({event:'GENERATION_MEDIA_HOLD',reason:input.operationId+':'+phase+':'+diagnosticReasons(error).join(':')});}catch{}throw error;}
    },
    schedule:async input=>scheduler.enqueue({...scopeOf(await ports.readScope({roomId})),operationId:input.operationId})});
  scheduler=createDurableCloudScheduler({enabled,readScope:ports.readScope,withOwnerAuthorization:withOwner,workerId,now,onDiagnostic,
    repository:createDurableSchedulerRepository({enabled,query:repository.privateStateQuery}),
    executeClaim:context=>leaseContext.run(context,()=>createCloudRecoveryRunner({enabled,jobs,authorityGuard,repository,
      readScope:ports.readScope,withOwnerAuthorization:withOwner,candidates:{scanIds:context.scanIds},now}).runOnce({...scopeOf(context.claim),limit:1}))});
  const readMedia=async input=>{
    const r=await playbackAssets.read(input.assetId),proof=await playbackAssets.verifySaved({binding:r.binding,
      asset:{assetId:r.assetId,sha256:r.sha256}});
    if(input.roomId!==roomId||r.sha256!==input.sha256)fail('MEDIA_CHECKSUM_MISMATCH');
    return {...r,privateSaved:proof.privateSaved,checksumVerified:proof.checksumVerified};
  };
  const httpCoordinator={execute:async input=>{
    try{
      if(input.action==='start'&&(await readPlaybackSnapshot({roomId})).playback.stopped){
        if(!await authorizeOwner(input))fail('OWNER_DENIED');
        return await repository.request('cueStart',roomId,input.ownerCapability,{current:await typedHost.readStartupCurrent({roomId})});
      }
      return await coordinator.execute(input);
    }catch(error){try{onDiagnostic({event:'CUE_REQUEST_HOLD',reason:input.action+':'+diagnosticReasons(error).join(':')});}catch{}throw error;}
  }};
  const projection=createCloudRoomProjection({roomRepository:{request:repository.roomRead},authorizeOwner,
    readAttachments:ports.readAttachments,readOperation:ports.readOperation,readPlaybackState:ports.readPlaybackState,now});
  const httpJobs = {
    read: jobs.read, stop: jobs.stop,
    start: async input => {
      await jobs.start(input);
      // The owner's explicit begin may deliver only the first intent. All
      // subsequent progress belongs to the persisted single-holder lease.
      return jobs.submitInitialIntent(input);
    },
    advance: async input => {
      const view = await jobs.read(input);
      if (view.state === 'PENDING' || view.state === 'WAIT_QC')
        await scheduler.enqueue({...scopeOf(await ports.readScope({roomId})),operationId:input.operationId});
      return view;
    }
  };
  // Verified immutable video descriptors may be prepared before the finite
  // audio clock. This caches no grant, scope, reservation or actual frontier.
  const preparedVideoDescriptors=new Map();
  async function videoDescriptor(clip){
    const key=cueDigest({assetId:clip.assetId,sha256:clip.sha256});
    if(preparedVideoDescriptors.has(key))return structuredClone(preparedVideoDescriptors.get(key));
    const asset=await playbackAssets.read(clip.assetId);
    if(asset.sha256!==clip.sha256)fail('MEDIA_CHECKSUM_MISMATCH');
    const p=asset.provenance,descriptor={assetId:clip.assetId,sha256:clip.sha256,byteLength:asset.byteLength,mimeType:'video/mp4',
      ...(p.kind==='owner-supplied-bootstrap-video'?{source:p.kind,admissionId:p.admissionId,admissionEvidenceSha256:p.admissionEvidenceSha256}:
        {source:'provider-response-replay',requestId:p.requestId})};
    if(preparedVideoDescriptors.size>=32)preparedVideoDescriptors.delete(preparedVideoDescriptors.keys().next().value);
    preparedVideoDescriptors.set(key,structuredClone(descriptor));return descriptor;
  }
  const mainHandler=createCloudFirstHandler({enabled,jobs:httpJobs,coordinator:httpCoordinator,roomProjection:projection,origin,fallback:existingRoomHandler,
    mediaPorts:{enabled,enableClipRelativeTimeline:true,authorizeOwner,readMedia,
      checkReservation:async input=>{
        const snapshot=await readPlaybackSnapshot({roomId}),state=snapshot.playback,r=snapshot.runtime?.pending;
        if(!r||state.stopped||r.cue.cueId!==input.cueId||r.expiresAtMs<=now())return {valid:false};
        return {valid:true,reservation:r};
      },describeManifest:async ({reservation:r})=>{
        try {
        const cue=r.cue,render=await worker.describeReservedRender({roomId,cue,plan:r.plan,expectedRevision:r.expectedRevision});
        return {roomId,cueId:cue.cueId,generationId:cue.generationId,submissionId:cue.submissionId,controlVersion:cue.controlVersion,
          commonIntentSha256:cue.commonIntentSha256,audio:{...cue.music.asset,render},videos:await Promise.all(cue.video.clips.map(videoDescriptor))};
        }catch(error){try{onDiagnostic({event:'PLAYBACK_MANIFEST_HOLD',reason:diagnosticReasons(error).join(':')});}catch{}throw error;}
      }}});
  // readScope already rejects disabled owners, then returns the bounded public
  // scope fields. Preserve that verified result for the operator's explicit gate.
  const readOperatorScope=async input=>({...await ports.readScope(input),ownerEnabled:true});
  const operatorPlans=createOperatorPlanStore({query:repository.privateStateQuery,withOwnerAuthorization:withOwner});
  // Only the native upload verifier supplies these descriptors. Source selection
  // precedes playback, while a trial may only revalidate the frozen source.
  let sourcePreparation=Promise.resolve(),verifiedNativeBootstrapScope=null,operatorSourceRegistered=false,preloadedReadyKey=null;
  async function prepareSelectedBootstrap(scope,media){
    const current=await ports.readScope({roomId});
    if(cueDigest(scopeOf(scope))!==cueDigest(scopeOf(current))||current.expiresAtMs<=now())fail('OPERATOR_SCOPE_CHANGED');
    const selected=await media.listSelected(scope),seed=selected.find(a=>a.role==='seed'),reference=selected.find(a=>a.role==='reference');
    if(!seed||!reference)return false;
    if(bootstrapConfiguration.audioSha256&&bootstrapConfiguration.audioSha256!==seed.sha256||
      bootstrapConfiguration.referenceSha256&&bootstrapConfiguration.referenceSha256!==reference.sha256)
      fail('APPROVED_BOOTSTRAP_CONFIGURATION_CHANGED');
    // Native preparation already verified these exact immutable source assets.
    // Selection callbacks must not start the same bootstrap preparation again.
    if(bootstrapReady&&cueDigest(verifiedNativeBootstrapScope)===cueDigest(scopeOf(scope))&&bootstrapConfiguration.audioAssetId===seed.assetId&&
      bootstrapConfiguration.referenceAssetId===reference.assetId)return true;
    const previous={...bootstrapConfiguration};
    Object.assign(bootstrapConfiguration,{audioAssetId:bootstrapConfiguration.audioAssetId??seed.assetId,audioSha256:seed.sha256,
      referenceAssetId:bootstrapConfiguration.referenceAssetId??reference.assetId,referenceSha256:reference.sha256});
    // Record the prepared scope like the approved path so later readiness checks
    // reuse it instead of rereading, rehashing and redecoding the bootstrap.
    try{const selected=await bootstrap.prepare();active();bootstrapReady=true;verifiedNativeBootstrapScope=scopeOf(selected??scope);return true;}
    catch(error){for(const key of Object.keys(bootstrapConfiguration))delete bootstrapConfiguration[key];Object.assign(bootstrapConfiguration,previous);throw error;}
  }
  function selectedAsset({scope,descriptor},media){
    if(!['seed','reference'].includes(descriptor.role))return;
    const pending=sourcePreparation.then(()=>prepareSelectedBootstrap(scope,media));
    sourcePreparation=pending.catch(()=>{});return pending;
  }
  async function ensureBootstrapReady(){
    if(operatorConfiguration.enabled!==true){await bootstrap.prepare();bootstrapReady=true;return;}
    const scope=await readOperatorScope({roomId}),media=operatorRuntime.media;
    if(operatorSourceRegistered&&bootstrapReady&&cueDigest(verifiedNativeBootstrapScope)===cueDigest(scopeOf(scope)))return;
    if(typeof media?.listSelected!=='function'||typeof media?.registerExisting!=='function')fail('OPERATOR_ASSET_REQUIRED');
    const selected=await media.listSelected(scope);
    if(selected.some(a=>a.role==='seed')&&selected.some(a=>a.role==='reference')){
      await selectedAsset({scope,descriptor:{role:'seed'}},media);operatorSourceRegistered=true;return;
    }
    if(!bootstrapConfiguration.audioAssetId||!bootstrapConfiguration.referenceAssetId)fail('OPERATOR_ASSET_REQUIRED');
    // Record the prepared scope here too, so registering the fixed assets
    // reuses this preparation instead of repeating the private read/decode.
    const prepared=await bootstrap.prepare();active();bootstrapReady=true;verifiedNativeBootstrapScope=scopeOf(prepared??scope);
    if(!selected.some(a=>a.role==='seed'))await media.registerExisting({scope,assetId:bootstrapConfiguration.audioAssetId,role:'seed'});
    if(!selected.some(a=>a.role==='reference'))await media.registerExisting({scope,assetId:bootstrapConfiguration.referenceAssetId,role:'reference'});
    operatorSourceRegistered=true;
  }
  async function readOperatorVisualEdit(input){
    if(operatorConfiguration.enabled!==true)return null;
    const scope=await ports.readScope({roomId:input.roomId}),activePlan=await operatorPlans.active(scope);
    let plan=activePlan;
    if(!plan?.operations?.some(o=>o.operationId===input.operationId)&&plan?.participants===3)
      plan=await operatorPlans.read({...scope,planId:plan.priorPlanId});
    if(!plan||!['CLAIMED','STARTED'].includes(plan.phase)||plan.expiresAtMs<=now()||
      cueDigest(scopeOf(plan))!==cueDigest(scopeOf(scope))||!plan.operations.some(o=>o.operationId===input.operationId))
      fail('OPERATOR_PLAN_CHANGED');
    const operation=await ingestion.readOperationMetadata(input),planned=plan.operations.find(o=>o.operationId===input.operationId),
      reference=plan.assets.find(a=>a.role==='reference'),
      chosen=plan.assets.find(a=>a.role==='saved-video');
    if(!planned||planned.submissionId!==operation.submissionId||planned.permitId!==operation.permit.permitId||
      planned.permit?.connectionId!==plan.connectionId||operation.permit.connectionId!==plan.connectionId||
      plan.sourceSha256!==operation.permit.sourceSha256||
      cueDigest(permitIdentity(planned.permit))!==cueDigest(permitIdentity(operation.permit)))fail('OPERATOR_PLAN_CHANGED');
    if(!reference||!chosen||chosen.referenceSha256!==reference.sha256||
      operation.permit.source.video.referenceSha256!==reference.sha256)fail('OPERATOR_REFERENCE_CHANGED');
    const descriptor=await operatorRuntime.media.read({...scopeOf(scope),assetId:chosen.assetId});
    if(cueDigest(Object.fromEntries(Object.keys(chosen).map(k=>[k,descriptor[k]])))!==cueDigest(chosen))fail('OPERATOR_ASSET_CHANGED');
    if(cueDigest(scopeOf(await ports.readScope({roomId})))!==cueDigest(scopeOf(scope)))fail('OPERATOR_SCOPE_CHANGED');
    // Through the saved video's measured end: a provider clip slightly under
    // 5s is covered instead of leaving the 24s timeline short.
    return {clips:[{assetId:chosen.assetId,sha256:chosen.sha256,inSeconds:0,toEnd:true}]};
  }
  readOperatorConnectionBinding=async input=>{
    const scope=await ports.readScope({roomId:input.roomId}),plan=await operatorPlans.active(scope);
    const priorPlan=plan?.participants===3?await operatorPlans.read({...scope,planId:plan.priorPlanId}):null;
    const result=resolveOperatorConnectionBinding({scope,plan,priorPlan,operationId:input.operationId,now});
    if(cueDigest(scopeOf(scope))!==cueDigest(scopeOf(await ports.readScope({roomId:input.roomId}))))fail('OPERATOR_SCOPE_CHANGED');return result;
  };
  function buildOperator(configuration){
    const adapters=configuration.enabled===true&&configuration.adapters?.enabled===true?
      createProductionOperatorAdapters({enabled,configuration:configuration.adapters,readScope:readOperatorScope,
        readOperation:ports.readAuthoritativeOperation,readConnectionBinding:readOperatorConnectionBinding,readCurrentSource:typedHost.readCurrentSource,
        readPreparationSource,
        readBootstrapAuthority:bootstrap.readStartAuthority,bootstrapConfiguration,privateStore,fetchImpl,now}):null;
    let media;
    try{
      const connections=adapters?.connections??configuration.connections;
      media=configuration.enabled===true?createOperatorMedia({enabled,
        assetStore:privateStore.assetStore,readScope:readOperatorScope,now,
        inspectAudio:async bytes=>(await getNative()).inspectBootstrap(bytes),inspectVideo:native.inspectVideo,
        inspectReference:async bytes=>(await getNative()).inspectReference(bytes),
        verifySavedVideo:adapters?.verifySavedVideo??configuration.verifySavedVideo,
        ownerBootstrapVideoApproved:adapters?.ownerBootstrapVideoApproved??configuration.ownerBootstrapVideoApproved,
        beforeBegin:async()=>{
          const scope=await readOperatorScope({roomId});
          if(bootstrapReady&&cueDigest(verifiedNativeBootstrapScope)===cueDigest(scopeOf(scope)))return;
          if(bootstrapConfiguration.audioAssetId&&bootstrapConfiguration.referenceAssetId)await ensureBootstrapReady();
        },
        onSelectedAsset:input=>selectedAsset(input,media)}):null;
      const trial=configuration.trial?{...configuration.trial,
        ...(adapters?{quoteAndBalance:adapters.quoteAndBalance,signSource:adapters.signSource}:{}),
        plans:operatorPlans,insertPermits:operatorPlans.insertPermits,
        readSubmissions:async scope=>withOwner(scope,async ctx=>(await repository.readRoom(roomId,ctx.ownerCapability)).submissions),
        readSource:async ({assets})=>{
          const seed=assets.find(a=>a.role==='seed'),reference=assets.find(a=>a.role==='reference');
          const selected=await bootstrap.readStartAuthority(await ports.readScope({roomId}));
          if(!seed||!reference||seed.sha256!==selected.source.music.sha256||reference.sha256!==selected.source.video.referenceSha256)
            fail('APPROVED_BOOTSTRAP_CONFIGURATION_CHANGED');
          return readPreparationSource({roomId});
        },
        readProgress:async ({plan,...scope})=>{
          const state=await ports.readPlaybackState(scope),runtime=await ports.readRoomRuntime(scope);
          const priorPlan=plan.participants===3?await operatorPlans.read({...scope,planId:plan.priorPlanId}):null;
          return {completedParticipants:countOperatorTrialCredits({plan,priorPlan,playback:state,runtime})};
        },
        beginOperation:async input=>withOwner(input,async ctx=>{
          const args={roomId,operationId:input.operationId,permitId:input.permitId,submissionId:input.submissionId,ownerCapability:ctx.ownerCapability};
          executionConsent=true;await jobs.start(args);return jobs.submitInitialIntent(args);
        })}:undefined;
      const readiness=adapters?.capabilities();
      const operator=createOwnerOperator({...configuration,macRequired:!serverManaged,serverManaged,approvals:adapters?{
        ...configuration.approvals,connection:configuration.approvals?.connection===true&&readiness.connectionReady,
        media:configuration.approvals?.media===true&&readiness.mediaReady,
        trial:configuration.approvals?.trial===true&&readiness.trialReady}:configuration.approvals,
        connections,media,trial,enabled:enabled&&configuration.enabled===true,
        origin,roomId,authorizeOwner,readScope:readOperatorScope,now});
      return {adapters,media,connections,operator,trial};
    }catch(error){media?.close();adapters?.close();throw error;}
  }
  operatorRuntime=buildOperator(operatorConfiguration);
  operatorConnections=operatorRuntime.connections;
  const resultReconciler=createProviderResultReconciler({enabled,now,assetStore:privateStore.assetStore,fetchImpl,
    readFacts:async input=>{
      const scope=await ports.readScope({roomId:input.roomId});
      const operation=await repository.request('read',roomId,input.ownerCapability,{operationId:input.operationId});
      const permitScope=await readDispatchPermit({roomId,permitId:operation.permit?.permitId});
      const playback=await readBoundPlayback({roomId}),plan=await operatorPlans.active(scope);
      const binding=resolveOperatorResultConnectionBinding({scope,plan,operationId:input.operationId});
      const planned=plan.operations.find(o=>o.operationId===input.operationId);
      if(planned.submissionId!==operation.submissionId||cueDigest(planned.permit)!==cueDigest(operation.permit)||
        plan.sourceSha256!==operation.permit.sourceSha256)fail('OPERATOR_RESULT_PLAN_CHANGED');
      const after=await ports.readScope({roomId});
      if(cueDigest(scopeOf(scope))!==cueDigest(scopeOf(after))||scope.expiresAtMs!==after.expiresAtMs)fail('OPERATOR_SCOPE_CHANGED');
      return {scope,operation,permitScope,playback,connectionId:binding.connectionId};
    },
    withCredential:(facts,invoke)=>{
      if(operatorConfiguration.enabled!==true||operatorConfiguration.approvals?.trial!==true||
        typeof operatorConnections?.withCredential!=='function')fail('OPERATOR_RESULT_CONNECTION_REQUIRED');
      // The separate historical plan binding above gates this callback. The
      // dispatch-only forOperation() resolver and its expiry checks stay intact.
      return operatorConnections.withCredential({...scopeOf(facts.scope),connectionId:facts.connectionId},invoke);
    },
    provider:Object.fromEntries(['status','result'].map(method=>[method,async input=>{
      active();sdk??=await loadSDK();return createReadOnlyGenerationProvider({createFalClient:(sdk.default??sdk).createFalClient,fetchImpl})[method](input);
    }])),
    inspectMedia:createReconciledMediaInspector({assetStore:privateStore.assetStore,native})});
  const rawMedia=createCloudMediaHandler({origin,authorizeOwner,readMedia});
  async function startScheduler(){
    if(!schedulerRunning){const scope=scopeOf(await ports.readScope({roomId}));active();
      // The private loop outlives this HTTP request. Do not inherit its owner
      // callback or actor: each scheduler request must authenticate afresh.
      actorContext.run(null,()=>runBackground(()=>scheduler.start(scope)));schedulerRunning=true;}
  }
  async function resumePlan({refresh=false}={}){
    const scope=await readOperatorScope({roomId});let plan=await operatorPlans.active(scope);
    if(!plan||!['STARTED','CLAIMED'].includes(plan.phase)||
      cueDigest(scopeOf(plan))!==cueDigest(scopeOf(scope)))fail('OPERATOR_PLAN_CHANGED');
    if(plan.executionAuthorization){
      validateExecutionAuthorization(plan.executionAuthorization,{plan,scope,now});
      if(refresh)plan=await refreshExecutionEvidence({plan,scope,connections:operatorConnections,trial:operatorRuntime.trial,now,reuseCurrent:true});
    }else if(plan.expiresAtMs<=now())fail('OPERATOR_PLAN_CHANGED');
    return {scope,plan};
  }
  const projectionReads=new Map();
  async function handleRequest(request){
    const url=new URL(request.url),proof=request.headers.get('x-room-owner');
    if(request.method!=='GET'||![`/api/rooms/${roomId}`,`/api/rooms/${roomId}/operator/status`].includes(url.pathname)||url.search||
      request.headers.get('origin')!==origin||!/^[a-f0-9]{64}$/.test(proof??''))return handleProductionRequest(request);
    // Multiple owner display polls share one in-flight projection only. No
    // completed response is cached, and commands/other owner proofs never join.
    const prior=projectionReads.get(url.pathname);
    if(prior?.proof===proof)return (await prior.task).clone();
    const pending={proof,task:handleProductionRequest(request)};projectionReads.set(url.pathname,pending);
    try{return (await pending.task).clone();}finally{if(projectionReads.get(url.pathname)===pending)projectionReads.delete(url.pathname);}
  }
  async function handleProductionRequest(request){
    const url=new URL(request.url),path=url.pathname;
    const executionReady=enabled&&!closed&&(operatorConfiguration.enabled!==true||bootstrapReady);
    if(path==='/api/room-capabilities')return reply({mode:'collect',durable:true,ownerLogin:'email-link-pkce',generation:executionReady,autoDJ:executionReady,
      cloud:{generationJobs:enabled&&!closed,portableQC:enabled&&!closed,browserPlayback:enabled&&!closed,playerObserver:enabled&&!closed,
        clipRelativeTimeline:enabled&&!closed,durableScheduler:enabled&&!closed,showMode:enabled&&!closed&&showMode},actualProviderWorkVerified:false,livePlaybackVerified:false,operator:operatorRuntime.operator.capabilities()});
    if(!path.startsWith('/api/rooms/'+roomId))return enabled&&!closed?existingRoomHandler(request):reply({error:'PRODUCTION_HOST_NOT_ACTIVATED'},503);
    const proof=request.headers.get('x-room-owner');
    return actorContext.run({ownerCapability:proof},async()=>{try{
      let setup;
      if(deferScheduler&&path===`/api/rooms/${roomId}/operator/resume`){
        if(request.method!=='POST'||request.headers.get('origin')!==origin||request.headers.has('authorization')||
          request.headers.get('content-type')?.split(';')[0]!=='application/json'||!await authorizeOwner({roomId,ownerCapability:proof}))return reply({error:'OWNER_DENIED'},403);
        let resumePhase='input';
        try{active();const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.length>4096)fail('OPERATOR_BODY_LIMIT');
          const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));let {scope,plan}=await resumePlan();
          if(!exactKeys(body,['planId','maximumCents','consent'])||body.consent!==true||body.planId!==plan.planId||
            body.maximumCents!==plan.maximumCents||operatorConfiguration.approvals?.trial!==true)fail('OPERATOR_TRIAL_CONSENT_REQUIRED');
          resumePhase='evidence-refresh';if(plan.executionAuthorization)({scope,plan}=await resumePlan({refresh:true}));
          resumePhase='source';const preparation=plan.operations.every(o=>isBootstrapPreparationSource(o.permit.source));
          const source=preparation?await readPreparationSource({roomId}):await typedHost.readCurrentSource({roomId});
          if((preparation?!isBootstrapPreparationSource(source):source.playback?.actual!==true)||
            cueDigest(cueSourceIdentity(source))!==plan.sourceSha256)fail('OPERATOR_SOURCE_CHANGED');
          resumePhase='safety';await operatorConfiguration.adapters.readSafetyApproval({...scope,connectionId:plan.connectionId});
          resumePhase='stability';const latest=await resumePlan();if(cueDigest(latest.plan)!==cueDigest(plan))fail('OPERATOR_PLAN_CHANGED');
          resumePhase='scheduler';executionConsent=true;await startScheduler();return reply({phase:'STARTED',planId:plan.planId,maximumCents:plan.maximumCents,resumed:true});
        }catch(error){try{onDiagnostic({event:'OPERATOR_RESUME_HOLD',reason:resumePhase+':'+(/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message??'')?error.message:'FAILED')});}catch{}
          return reply({error:'OPERATOR_RESUME_HOLD'},409);}
      }
      if(deferScheduler&&!executionConsent&&/^\/api\/rooms\/[^/]+\/jobs\/(start|advance)$/.test(path))
        return reply({error:'OPERATOR_EXPLICIT_RESUME_REQUIRED'},409);
      if(path.includes('/operator/')){
        if(configuringOperator)return reply({error:'OPERATOR_CONFIGURATION_HOLD'},409);
        activeOperatorRequests++;
        try{setup=await operatorRuntime.operator.handleRequest(request);}finally{activeOperatorRequests--;}
      }
      if(setup){
        if(deferScheduler&&setup.ok&&path.endsWith('/operator/trial/start'))await startScheduler();
        if(setup.ok&&path.endsWith('/operator/trial/status')){
          const result=await setup.json(),scope=await ports.readScope({roomId}),plan=await operatorPlans.active(scope);
          if(plan?.planId!==result.planId)fail('OPERATOR_RESULT_PLAN_CHANGED');
          // Explicit status action only; periodic display GETs never contact the
          // provider. An unexpired plan continues through the normal worker.
          if(plan.expiresAtMs<=now()&&['STARTED','CLAIMED','UNKNOWN'].includes(plan.phase)){
            const reconciliation=[];
            for(const op of plan.operations)try{
              reconciliation.push(await resultReconciler.reconcile({roomId,operationId:op.operationId,ownerCapability:proof}));
            }catch(error){reconciliation.push({operationId:op.operationId,state:'HOLD',
              reason:/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message??'')?error.message:'RESULT_RECONCILIATION_HOLD',
              spendingAuthorized:false,cueEligible:false});}
            result.reconciliation=reconciliation;
          }
          return reply(result);
        }
        if(deferScheduler&&setup.ok&&path.endsWith('/operator/status')){
          const result=await setup.clone().json();result.executionPaused=!executionConsent;
          if(!executionConsent&&operatorConfiguration.approvals?.trial===true)try{
            const {plan}=await resumePlan();result.resumePlan={phase:'REVIEW',resume:true,planId:plan.planId,participants:plan.participants,
              newParticipants:plan.operations.length,maximumCents:plan.maximumCents,infrastructureMaximumUsd:plan.infrastructureMaximumUsd,
              counts:{intent:plan.operations.length,music:plan.operations.length,video:plan.operations.length},expiresAtMs:plan.expiresAtMs,
              ...(plan.executionAuthorization?{executionAuthorization:{expiresAtMs:null,generationMaximumCents:150,infrastructureMaximumCents:150,totalReservationCents:plan.executionAuthorization.totalReservationCents}}:{})};
          }catch{}
          return reply(result);
        }
        return setup;
      }
      if(path===`/api/rooms/${roomId}/source/startup`){
        if(request.method!=='POST'||request.headers.get('origin')!==origin||request.headers.has('authorization')||request.headers.has('x-fal-key'))return reply({error:'OWNER_OR_ORIGIN_DENIED'},403);
        try{active();if(!await authorizeOwner({roomId,ownerCapability:proof}))fail('OWNER_DENIED');
          await emptyBody(request);
          await ensureBootstrapReady();const value=await bootstrap.startup();bootstrapReady=true;
          return reply({...value,waitForGeneration:operatorConfiguration.enabled===true&&operatorConfiguration.approvals?.trial===true});}catch{return reply({error:'SOURCE_STARTUP_HOLD'},409);}
      }
      if(path===`/api/rooms/${roomId}/playback/preload`){
        if(request.method!=='POST'||request.headers.get('origin')!==origin||request.headers.has('authorization')||request.headers.has('x-fal-key'))return reply({error:'OWNER_OR_ORIGIN_DENIED'},403);
        if(!await authorizeOwner({roomId,ownerCapability:proof}))return reply({error:'OWNER_DENIED'},403);
        // The output waits at most 300s for this whole request: measure from ingress.
        const preloadStart=now();
        await emptyBody(request);await ensureBootstrapReady();
        const before=await readPlaybackSnapshot({roomId}),assets=new Map(),sources=new Map();
        const candidates=before.playback.cues.filter(c=>c.status==='READY').slice(0,3);
        const add=asset=>{const prior=assets.get(asset.assetId);
          if(prior&&cueDigest(prior)!==cueDigest(asset))fail('PLAYBACK_PREFLIGHT_CHANGED');assets.set(asset.assetId,asset);};
        // The browser warm cache accepts at most 32 descriptors and 128 MiB and
        // rejects the whole response beyond either. Preload is only a cache:
        // an asset that does not fit is fetched later through its manifest.
        const fits=asset=>assets.has(asset.assetId)||assets.size<32&&
          [...assets.values()].reduce((n,a)=>n+a.byteLength,0)+asset.byteLength<=128*1024*1024;
        for(const candidate of candidates){
          const preparedSource=await typedHost.preparePublishedSource({roomId,operationId:candidate.operationId});
          if(preparedSource.source?.playback?.actual!==false)fail('PLAYBACK_PREFLIGHT_CHANGED');
          // Verify private bytes, lineage and context now, so this Cue's turn as
          // the current source needs only live reads inside its 24s window.
          const preverifyStart=now();
          await typedHost.preverifyPublishedSource({roomId,cue:candidate,source:preparedSource.source});
          try{onDiagnostic({event:'PLAYBACK_PREVERIFIED',reason:candidate.cueId.slice(0,24)+':'+(now()-preverifyStart)+'ms'});}catch{}
          // Keyed by operation: recovery can leave two READY copies of one cueId.
          sources.set(candidate.operationId,preparedSource.source);
          const prepared=await worker.preparePlaybackCandidate({roomId,candidate});
          await Promise.all(candidate.video.clips.map(videoDescriptor));
          for(const asset of prepared.assets)if(fits(asset))add(asset);
        }
        // Prepare possible next-Cue PCM before any finite graph starts. These
        // actual:false source snapshots grant no selection/current authority.
        // A later reservation must still match the live source SHA/revision.
        // Start a join render (~70s) only while at least ~110s of the output's
        // 300s preload wait remain, counted from request ingress (candidate
        // verification included); the rest is left to the background sweep.
        const pairDeadline=preloadStart+190000;
        pairs:for(const parent of candidates)for(const candidate of candidates){
          // Replays can share a cueId; only the identical operation is skipped.
          if(parent.operationId===candidate.operationId)continue;
          if(now()>=pairDeadline)break pairs;
          const asset=await pairPreparation.prepareOnce(parent,candidate,()=>worker.preparePlaybackPair({roomId,candidate,
            source:sources.get(parent.operationId),playbackRevision:PAIR_BASE_REVISION}));
          if(asset&&fits(asset))add(asset);
        }
        const after=await readPlaybackSnapshot({roomId});
        if(cueDigest(before)!==cueDigest(after))fail('PLAYBACK_PREFLIGHT_CHANGED');
        preloadedReadyKey=cueDigest(candidates);
        // Joins beyond this bounded browser preload set continue in the background.
        pairPreparation.schedule();
        return reply({roomId,assets:[...assets.values()]});
      }
      // Unload-safe Stop: one owner request (sent with keepalive as the page
      // closes) stops the graph first and the room's cues only with that
      // graph's real Stop receipt, the same order the output's explicit Stop
      // enforces. Independent requests could leave a stopped room with an
      // unstopped graph, or a stopped room without a graph receipt.
      if(path===`/api/rooms/${roomId}/player/unload-stop`){
        if(request.method!=='POST'||request.headers.get('origin')!==origin||request.headers.has('authorization'))return reply({error:'OWNER_OR_ORIGIN_DENIED'},403);
        if(!await authorizeOwner({roomId,ownerCapability:proof}))return reply({error:'OWNER_DENIED'},403);
        await emptyBody(request);
        const headers=new Headers(request.headers);headers.delete('content-length');headers.set('content-type','application/json');
        const graph=await observer.handleRequest(new Request(new URL(`/api/rooms/${roomId}/player/stop`,request.url),
          {method:'POST',headers,body:JSON.stringify({current:true})}));
        const receipt=graph?.ok?await graph.json().catch(()=>null):null;
        const graphStopped=receipt?.kind==='selected-player-graph-stopped-v1'&&receipt.stopped===true&&
          Number.isSafeInteger(receipt.graphEpoch)&&receipt.graphEpoch>0&&/^[a-f0-9]{64}$/.test(receipt.receiptSha256??'');
        if(graphStopped)await httpCoordinator.execute({action:'stop',roomId,ownerCapability:proof});
        return reply({graphStopped,roomStopped:graphStopped});
      }
      if(path.endsWith('/player/register')&&await authorizeOwner({roomId,ownerCapability:proof})){
        await ensureBootstrapReady();
        // Finish immutable render/media verification before the fresh graph
        // lease and finite initial audio begin. This neither selects nor
        // reserves a Cue, credits a guest, nor invokes a provider.
        const before=await readPlaybackSnapshot({roomId}),started=now();
        // The preload already verified these exact READY Cues before Start;
        // repeating it here re-downloaded tens of MB and delayed the finite
        // source (~92s in production). Every commit still re-verifies media.
        const readyKey=cueDigest(before.playback.cues.filter(c=>c.status==='READY').slice(0,3));
        if(readyKey!==preloadedReadyKey){
          for(const candidate of before.playback.cues.filter(c=>c.status==='READY').slice(0,3))
            await worker.preparePlaybackCandidate({roomId,candidate});
          const after=await readPlaybackSnapshot({roomId});
          if(cueDigest(before)!==cueDigest(after))fail('PLAYBACK_PREFLIGHT_CHANGED');
        }
        try{onDiagnostic({event:'CUE_TIMING',reason:'register:'+(readyKey===preloadedReadyKey?'reused':'verified')+'='+(now()-started)})}catch{}
      }
      const observed=await observer.handleRequest(request);
      // Return the physical observation's committed result immediately. The
      // preload path already saves actual:false generated-source contexts.
      // CURRENT reads independently authenticate their current credit, saved
      // bytes and fresh PCM/video frontier. Repeating context preparation here
      // stalls that very frontier and can turn a committed CAS into a409 reply.
      if(observed)return observed;
      return (await typedHost.handleRequest(request))??(await rawMedia(request))??(await mainHandler(request))??reply({error:'NOT_FOUND'},404);
    }catch{return reply({error:'PRODUCTION_HOST_HOLD'},409);}
    });
  }
  return Object.freeze({handleRequest,io,jobs,worker,observer,typedHost,scheduler,bootstrap,visualPlan,
    get bootstrapReady(){return bootstrapReady;},
    get operator(){return operatorRuntime.operator;},
    async configureApprovedOperator({connectionId,operatorConfiguration:nextConfiguration}={}){
      active();
      if(configuringOperator||!operatorId(connectionId)||!exactKeys(nextConfiguration,['enabled','adapters','trial','approvals'])||
        nextConfiguration.enabled!==true||!exactKeys(nextConfiguration.adapters,
          ['enabled','balanceMode','approvedVideoAssetIds','readSafetyApproval',
            ...(nextConfiguration.adapters?.ownerBootstrapVideoApproved!==undefined?['ownerBootstrapVideoApproved']:[])])||
        nextConfiguration.adapters.enabled!==true||!(nextConfiguration.adapters.balanceMode==='api'||
          deferScheduler&&nextConfiguration.adapters.balanceMode==='manual-attested')||
        nextConfiguration.adapters.ownerBootstrapVideoApproved!==undefined&&typeof nextConfiguration.adapters.ownerBootstrapVideoApproved!=='boolean'||
        typeof nextConfiguration.adapters.readSafetyApproval!=='function'||
        !Array.isArray(nextConfiguration.adapters.approvedVideoAssetIds)||
        nextConfiguration.adapters.approvedVideoAssetIds.length<1&&nextConfiguration.adapters.ownerBootstrapVideoApproved!==true||
        nextConfiguration.adapters.approvedVideoAssetIds.length>8||
        nextConfiguration.adapters.approvedVideoAssetIds.some(v=>!operatorId(v))||
        new Set(nextConfiguration.adapters.approvedVideoAssetIds).size!==nextConfiguration.adapters.approvedVideoAssetIds.length||
        !exactKeys(nextConfiguration.trial,['mediaHost','infrastructure',
          ...(Object.hasOwn(nextConfiguration.trial??{},'maximumParticipants')||Object.hasOwn(nextConfiguration.trial??{},'maximumCents')?['maximumParticipants','maximumCents']:[])])||
        Object.hasOwn(nextConfiguration.trial??{},'maximumParticipants')&&
          (nextConfiguration.trial.maximumParticipants!==5||nextConfiguration.trial.maximumCents!==250)||
        nextConfiguration.trial.mediaHost!==new URL(projectURL).hostname||
        !exactKeys(nextConfiguration.trial.infrastructure,['verified','maximumUsd'])||
        nextConfiguration.trial.infrastructure.verified!==true||
        !Number.isFinite(nextConfiguration.trial.infrastructure.maximumUsd)||
        nextConfiguration.trial.infrastructure.maximumUsd<0||nextConfiguration.trial.infrastructure.maximumUsd>1.5||
        !exactKeys(nextConfiguration.approvals,['connection','media','trial'])||
        Object.values(nextConfiguration.approvals).some(v=>v!==true)||
        operatorConfiguration.adapters?.enabled!==true||!operatorConfiguration.adapters.custodian)
        fail('APPROVED_OPERATOR_CONFIGURATION_REQUIRED');
      configuringOperator=true;
      try{
        const before=await ports.readScope({roomId}),scope=scopeOf(before);
        if(before.closed||before.expiresAtMs<=now()||activeOperatorRequests)fail('OPERATOR_SCOPE_CHANGED');
          const restoredPlan=await operatorPlans.active(before);
          if(restoredPlan&&!(deferScheduler&&!executionConsent&&!schedulerRunning&&restoredPlan.connectionId===connectionId&&cueDigest(scopeOf(restoredPlan))===cueDigest(scopeOf(before))))fail('OPERATOR_SCOPE_CHANGED');
        const connection=await operatorConnections.read({...scope,connectionId});
        if(connection?.connectionId!==connectionId||connection.verified!==true||connection.expiresAtMs<=now())
          fail('OPERATOR_CONNECTION_REQUIRED');
        const configured={...nextConfiguration,adapters:{...nextConfiguration.adapters,
          approvedVideoAssetIds:[...nextConfiguration.adapters.approvedVideoAssetIds],
          custodian:operatorConfiguration.adapters.custodian}};
        const replacement=buildOperator(configured);
        try{
          const after=await ports.readScope({roomId});
          if(after.closed||after.expiresAtMs<=now()||before.expiresAtMs!==after.expiresAtMs||
            cueDigest(scope)!==cueDigest(scopeOf(after))||activeOperatorRequests)fail('OPERATOR_SCOPE_CHANGED');
          const afterPlan=await operatorPlans.active(after);
          if(cueDigest(afterPlan??null)!==cueDigest(restoredPlan??null))fail('OPERATOR_SCOPE_CHANGED');
          if(afterPlan&&!(deferScheduler&&!executionConsent&&!schedulerRunning&&afterPlan.connectionId===connectionId&&cueDigest(scopeOf(afterPlan))===cueDigest(scopeOf(after))))fail('OPERATOR_SCOPE_CHANGED');
          const checked=await replacement.connections.read({...scope,connectionId});
          if(checked?.connectionId!==connectionId||checked.verified!==true||checked.expiresAtMs!==connection.expiresAtMs)
            fail('OPERATOR_CONNECTION_REQUIRED');
          await replacement.media?.listSelected?.(before);active();
        }catch(error){replacement.operator.close();replacement.media?.close();replacement.adapters?.close();throw error;}
        const previous=operatorRuntime;
        operatorConfiguration=configured;operatorConnections=replacement.connections;operatorRuntime=replacement;
        previous.operator.close();previous.media?.close();previous.adapters?.close();
        return replacement.operator.capabilities();
      }finally{configuringOperator=false;}
    },
    // Native composition only. Browser requests never select assets or assert QC.
    async prepareApprovedBootstrap(selection){active();
      if(!selection||Object.keys(selection).some(k=>!['audioAssetId','audioSha256','referenceAssetId','referenceSha256','motifId','fixedBpm','control'].includes(k)))fail('APPROVED_BOOTSTRAP_CONFIGURATION_REQUIRED');
      const previous={...bootstrapConfiguration};Object.assign(bootstrapConfiguration,selection);
      try{const selected=await bootstrap.prepare();active();bootstrapReady=true;verifiedNativeBootstrapScope=scopeOf(selected);
        if(operatorConfiguration.enabled===true)await ensureBootstrapReady();return selected;}
      catch(error){for(const key of Object.keys(bootstrapConfiguration))delete bootstrapConfiguration[key];Object.assign(bootstrapConfiguration,previous);throw error;}},
    async start(){active();if(operatorConfiguration.enabled!==true||bootstrapConfiguration.audioAssetId&&bootstrapConfiguration.referenceAssetId)
      await ensureBootstrapReady();if(!deferScheduler)await startScheduler();},
    capabilities:()=>({defaultActivation:false,implementationAssembled:true,enabled:enabled&&!closed,...(deferScheduler?{executionPaused:!executionConsent,schedulerStarted:schedulerRunning}:{}),actualApiVerified:false,liveAVVerified:false}),
    async close(){closed=true;pairPreparation.close();resultReconciler.close();operatorRuntime.operator.close();operatorRuntime.media?.close();operatorRuntime.adapters?.close();await scheduler.close();observer.close();material.close();bootstrap.close();typedHost.close();visualPlan.close();await worker.close();
      await ingestion.close();await nativePromise?.then(n=>n.close()).catch(()=>{});playbackAssets.close();await io.close();}});
}
