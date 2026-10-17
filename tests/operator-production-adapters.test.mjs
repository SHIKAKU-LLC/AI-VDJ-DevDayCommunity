import test from 'node:test';
import assert from 'node:assert/strict';
import {createFalPlatformAdapter,createFalQuoteAndBalance} from '../cloud/worker/fal-platform-adapter.mjs';
import {createOperatorConnections,resolveOperatorConnectionBinding} from '../cloud/worker/operator-connections.mjs';
import {createOperatorSourceSigner,createSavedVideoResolver} from '../cloud/worker/operator-source-adapters.mjs';
import {createProductionOperatorAdapters} from '../cloud/worker/production-operator-adapters.mjs';
import {createSupabaseStorageTransport} from '../cloud/worker/supabase-storage-transport.mjs';
import {PRIVATE_BUCKET_TARGET} from '../cloud/worker/supabase-private-store.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {verifiedBootstrapContext} from '../cloud/generation/bootstrap-source-contract.mjs';
import {createDispatchAuthority} from '../cloud/jobs/dispatch-authority.mjs';
import {GENERATION_CONTRACT,validatePermit} from '../cloud/generation/dispatch.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
import {syntheticWave,fixtureSha} from './cloud-worker-fixture.mjs';
import {deriveVerifiedWave} from '../integration/runtime/verified-wave-derivation.mjs';
import {INGESTION_RECEIPT_VERSION} from '../cloud/worker/private-ingestion.mjs';
import {inferenceInput} from '../snapshot/app/runtime/intent-semantics.mjs';
// sessionId is an anonymous room epoch, not an authentication session.
const scope={roomId:'11111111-1111-4111-a111-111111111111',['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,expiresAtMs:50000};
const credential='example_fixture_credential',connectionId='synthetic-connection',now=()=>1000;
const json=(v,status=200)=>Response.json(v,{status});
const priceRows=[['intent','dynamic_tokens',.1],['music','audio',.0446],['video','second',.08]].map(([k,unit,unit_price])=>({endpoint_id:GENERATION_CONTRACT[k],unit,unit_price,currency:'USD'}));
function platformFixture(extra={}){const calls=[];const platform=createFalPlatformAdapter({enabled:true,now,fetchImpl:async(url,options)=>{
 assert.equal(options.headers.get('authorization'),'Key '+credential);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');
 const u=new URL(url);assert.equal(u.origin,'https://api.fal.ai');calls.push(u.pathname+u.search);
 if(extra.response)return extra.response(url,options);
 if(u.pathname==='/v1/models/pricing'){assert.equal(u.searchParams.get('endpoint_id'),[GENERATION_CONTRACT.intent,GENERATION_CONTRACT.music,GENERATION_CONTRACT.video].join(','));return json({prices:priceRows,has_more:false,next_cursor:null});}
 assert.equal(u.pathname,'/v1/account/billing');assert.equal(u.searchParams.get('expand'),'credits');return json({username:'synthetic_account_not_projected',credits:{currency:'USD',current_balance:2}});
 },...extra.options});return {platform,calls};}
const approval=()=>({...scope,connectionId,approved:true,autoTopUp:false,observedAtMs:1000,evidenceSha256:'f'.repeat(64),manualBalanceUsd:2,bounds:{
 intent:{kind:'reviewed-model-token-ceiling',model:'google/gemini-2.5-flash-lite',maxOutputTokens:800,maxInputUtf8Bytes:56192,endpointUnit:'dynamic_tokens',endpointUnitPrice:.1,inputUsdPerMillion:.1,outputUsdPerMillion:.4,maximumUsd:.01},
 music:{kind:'reviewed-billing-units',configuration:{contextSeconds:16,tailSeconds:24},unit:'audio',quantity:1,maximumUsd:.05},
 video:{kind:'reviewed-billing-units',configuration:{duration:5,resolution:'480P'},unit:'second',quantity:5,maximumUsd:.4}}});
const quoteInput={...scope,connectionId,models:GENERATION_CONTRACT,participants:2};
test('five-person quote requires explicit native approval and keeps the auto top-up threshold untouched',async()=>{
 const x=platformFixture(),c=connectionFixture(x.platform);
 const a={...approval(),fivePersonMaximumCents:250,autoTopUp:true,manualBalanceSource:'fal-dashboard-observation-v1',manualBalanceUsd:13,
  topUpProtection:{kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,maximumSpendUsd:2.5,observedAtMs:1000,evidenceSha256:'b'.repeat(64)}};
 const quote=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>a,balanceMode:'manual-attested',now});
 assert.equal((await quote({...quoteInput,participants:5})).balance.usd,13);
 a.manualBalanceUsd=12.5;await assert.rejects(quote({...quoteInput,participants:5}),/BALANCE_REQUIRED/);
 a.manualBalanceUsd=13;delete a.fivePersonMaximumCents;
 await assert.rejects(quote({...quoteInput,participants:5}),/SAFETY_APPROVAL_REQUIRED/);
 c.connections.close();x.platform.close();
});
function connectionFixture(platform,extra={}){let accepted=0,resolved=0;const metadata={...scope,connectionId,verified:true};
 const custodian={accept:async input=>{assert.equal(input.credential,credential);assert.equal(input.verification.authenticated,true);accepted++;return metadata;},read:async()=>metadata,readActive:async()=>metadata,
 withCredential:async(_,invoke)=>{resolved++;return invoke(credential);},...extra.custodian};
 const connections=createOperatorConnections({enabled:true,platform,custodian,readScope:async()=>scope,
 readConnectionBinding:async i=>({...scope,...i,kind:'operator-plan-connection-binding-v1',connectionId}),now,...extra.options});
 return {connections,accepted:()=>accepted,resolved:()=>resolved,custodian};}
test('all production adapters are default-off with no secret, storage, scope or network access',async()=>{
 const deny=new Proxy({},{get(){assert.fail('disabled dependency access');}}),network=()=>assert.fail('disabled network');
 const p=createFalPlatformAdapter({fetchImpl:network});await assert.rejects(p.verifyCredential(credential),/NOT_ACTIVATED/);await assert.rejects(p.balance(credential),/NOT_ACTIVATED/);p.close();
 const c=createOperatorConnections({custodian:deny});await assert.rejects(c.connect({...scope,credential}),/NOT_CONFIGURED/);c.close();
 await assert.rejects(createOperatorSourceSigner({privateStore:deny})({...scope}),/NOT_ACTIVATED/);
 await assert.rejects(createSavedVideoResolver({assetStore:deny})({...scope}),/NOT_ACTIVATED/);
 const a=createProductionOperatorAdapters({configuration:deny,privateStore:deny,fetchImpl:network});assert.equal(a.capabilities().enabled,false);a.close();
});
test('official authenticated pricing verifies connection, scope-bound custodian resolves without an adapter key cache',async()=>{
 const x=platformFixture(),c=connectionFixture(x.platform),input={...scope,credential};
 const result=await c.connections.connect(input);assert.equal(input.credential,'');assert.equal(result.connectionId,connectionId);assert.equal(c.accepted(),1);assert(!JSON.stringify(result).includes(credential));
 assert.equal(await c.connections.forOperation({...scope,operationId:'synthetic-operation',connectionId}),credential);assert.equal(c.resolved(),1);
 assert.equal((await c.connections.readActive(scope)).connectionId,connectionId);
 await assert.rejects(c.connections.read({...scope,controlRevision:1,connectionId}),/SCOPE_CHANGED/);assert.equal(c.connections.capabilities().credentialCache,false);
 c.connections.close();x.platform.close();
});
test('pre-begin key binding reads the claimed frozen plan, never requires an operation row that cannot yet exist',()=>{
 const plan={...scope,planId:'synthetic-plan',participants:2,phase:'CLAIMED',connectionId,operations:[{operationId:'synthetic-operation',permit:{connectionId}}]};
 assert.equal(resolveOperatorConnectionBinding({scope,plan,operationId:'synthetic-operation',now}).connectionId,connectionId);
 for(const changed of [{...plan,phase:'REVIEW'},{...plan,controlRevision:1},{...plan,expiresAtMs:1000}])assert.throws(()=>resolveOperatorConnectionBinding({scope,plan:changed,operationId:'synthetic-operation',now}),/CONNECTION_CHANGED/);
 const next={...plan,planId:'synthetic-third',participants:3,priorPlanId:plan.planId,operations:[{operationId:'synthetic-third-operation',permit:{connectionId}}]};
 assert.equal(resolveOperatorConnectionBinding({scope,plan:next,priorPlan:{...plan,phase:'STARTED'},operationId:'synthetic-operation',now}).connectionId,connectionId);
});
test('API balance and exact unit/model ceilings form a trusted quote; dashboard Auto top-up attestation stays mandatory',async()=>{
 const x=platformFixture(),c=connectionFixture(x.platform),a=approval();
 const quote=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>a,now});
 const q=await quote(quoteInput);assert.deepEqual(q.quote.maximumUsd,{intent:.01,music:.05,video:.4});assert.equal(q.balance.usd,2);assert.equal(q.balance.autoTopUp,false);
 assert(!JSON.stringify(q).includes('synthetic_account_not_projected'));assert(!JSON.stringify(q).includes(credential));
 a.autoTopUp=true;await assert.rejects(quote(quoteInput),/SAFETY_APPROVAL/);a.autoTopUp=false;
 a.bounds.video.configuration.resolution='1080P';await assert.rejects(quote(quoteInput),/UNIT_APPROVAL/);a.bounds.video.configuration.resolution='480P';
 a.bounds.intent.maximumUsd=.001;await assert.rejects(quote(quoteInput),/INTENT_PRICE_APPROVAL/);c.connections.close();x.platform.close();
});
test('403 does not upgrade credentials or silently fall back; explicitly selected manual balance uses scoped fresh evidence',async()=>{
 const x=platformFixture({response:url=>new URL(url).pathname.endsWith('/billing')?json({error:{message:'ignored'}},403):json({prices:priceRows,has_more:false,next_cursor:null})}),c=connectionFixture(x.platform);
 const api=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>approval(),now});
 await assert.rejects(api(quoteInput),/PERMISSION_REQUIRED/);assert.equal(x.calls.length,2);
 const manual=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>approval(),balanceMode:'manual-attested',now});
 assert.equal((await manual(quoteInput)).balance.source,'manual-account-attestation');assert.equal(x.calls.length,3);c.connections.close();x.platform.close();
});
test('malformed, oversized, redirected and timed-out provider replies expose no raw credentials or errors',async()=>{
 for(const response of [()=>json({prices:[]}),()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),()=>{throw Error(credential);}]){
  const x=platformFixture({response});await assert.rejects(x.platform.prices(credential),e=>e.code.startsWith('FAL_PLATFORM_')&&!e.message.includes(credential));x.platform.close();}
 const x=platformFixture({response:()=>new Promise(()=>{}),options:{timeoutMs:5}});await assert.rejects(x.platform.prices(credential),/TIMEOUT/);x.platform.close();
});
test('custodian callback is once-only, late callbacks are rejected, errors and hangs stay sanitized',async()=>{
 const x=platformFixture();let late;
 const c=connectionFixture(x.platform,{custodian:{withCredential:async(_,fn)=>{late=fn;await fn(credential);await fn(credential);}}});
 await assert.rejects(c.connections.withCredential(quoteInput,()=>true),/CONTEXT_REQUIRED/);assert.throws(()=>late(credential),/CONTEXT_REQUIRED/);
 const hanging=connectionFixture(x.platform,{custodian:{read:()=>new Promise(()=>{})},options:{timeoutMs:5}});await assert.rejects(hanging.connections.read(quoteInput),/CONTEXT_REQUIRED/);
 const leaking=connectionFixture(x.platform,{custodian:{read:()=>{throw Error(credential);}}});await assert.rejects(leaking.connections.read(quoteInput),e=>!e.message.includes(credential));
 for(const p of [c,hanging,leaking])p.connections.close();x.platform.close();
});

test('Supabase signing uses exact private room media path, bounded expiry and official signedURL field',async()=>{
 const path='rooms/'+cueDigest(scope.roomId)+'/assets/synthetic-context.media',bucket=PRIVATE_BUCKET_TARGET;let calls=0,foreign=false;
 const transport=createSupabaseStorageTransport({enabled:true,roomId:scope.roomId,projectUrl:'https://example.supabase.co',now,
 readAuthHeaders:async()=>new Headers([['authorization','Bearer example_platform'],['apikey','example_platform']]),fetchImpl:async(url,o)=>{
  calls++;assert.equal(url,'https://example.supabase.co/storage/v1/object/sign/'+bucket+'/'+path);assert.deepEqual(JSON.parse(o.body),{expiresIn:9});assert.equal(o.redirect,'error');
  const payload=Buffer.from(JSON.stringify({url:bucket+'/'+path,exp:10})).toString('base64url');
  return json({signedURL:(foreign?'https://foreign.example':'')+'/object/sign/'+bucket+'/'+path+'?token=example.'+payload+'.example'});
 }});
 const input={bucket,path,expiresIn:9,signal:new AbortController().signal};const signed=await transport.signObject(input);assert.equal(new URL(signed.url).origin,'https://example.supabase.co');assert.equal(signed.expiresAtMs,10000);
 foreign=true;await assert.rejects(transport.signObject(input),/RESPONSE_REQUIRED/);
 await assert.rejects(transport.signObject({...input,path:'rooms/other/assets/synthetic-context.media'}),/ROOM_PATH/);assert.equal(calls,2);transport.close();
});

function sourceFixture(){const bytes=syntheticWave(24),parentSha=fixtureSha(bytes),derived=deriveVerifiedWave({bytes,byteLength:bytes.length,sha256:parentSha}),ref=Uint8Array.of(137,80,78,71,13,10,26,10);
 const records=new Map(),source={audioAssetId:'synthetic-parent',contextAssetId:'synthetic-context',referenceAssetId:'synthetic-reference',music:{clipId:'synthetic-seed',sha256:parentSha,contextSha256:derived.contextSha256,contextSeconds:16,contextVerified:true,ready:true,control:{version:1,energy:.4,tension:.3,density:.3,brightness:.45}},video:{motifId:'synthetic-motif',motifSnapshotSha256:'d'.repeat(64),referenceSha256:fixtureSha(ref)},quality:{fixedBpm:145,tempoConfidence:'assumed'},playback:{actual:true,phase:'PLAYING',revision:0,playedUntilFrame:512}};
 const evidence={kind:'verified-source-context-v1',roomId:scope.roomId,originKind:'provider',contextSeconds:16,serverAudioQC:true,parentAssetId:source.audioAssetId,parentSha256:parentSha,contextAssetId:source.contextAssetId,contextSha256:derived.contextSha256,referenceAssetId:source.referenceAssetId,referenceSha256:source.video.referenceSha256,providerReceipt:{requestId:'synthetic-parent-request',resultSha256:'e'.repeat(64)}};
 let signs=0;for(const [assetId,b,contentType] of [[source.audioAssetId,bytes,'audio/wav'],[source.contextAssetId,derived.contextBytes,'audio/wav'],[source.referenceAssetId,ref,'image/png']])records.set(assetId,{assetId,bytes:b,byteLength:b.length,sha256:fixtureSha(b),contentType,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'provider',...evidence.providerReceipt}});
 const assetStore={read:async id=>records.get(id),verifySaved:async({binding,asset})=>({...asset,binding,privateSaved:true,checksumVerified:true}),sign:async i=>{signs++;return {...i,url:'https://example.supabase.co/private/synthetic',private:true,checksumVerified:true,expiresAtMs:1000+i.expiresIn*1000};}};
 return {source,evidence,records,assetStore,signs:()=>signs,privateStore:{assetStore,readSourceEvidence:async()=>evidence}};}
test('source signer physically rechecks exact16s bytes/reference and refuses bootstrap relabeling before URL issuance',async()=>{
 const x=sourceFixture(),sign=createOperatorSourceSigner({enabled:true,privateStore:x.privateStore,readScope:async()=>scope,readCurrentSource:async()=>x.source,now});
 const result=await sign({...scope,source:x.source,expiresAtMs:10000});assert.equal(result.context.providerOriginVerified,true);assert.equal(x.signs(),2);
 x.evidence.originKind='owner-supplied-bootstrap';await assert.rejects(sign({...scope,source:x.source,expiresAtMs:10000}),/SOURCE_ORIGIN_REQUIRED/);assert.equal(x.signs(),2);
});
test('concrete injected connection/price/balance/source producers satisfy the unchanged generation permit contract',async()=>{
 const x=platformFixture(),c=connectionFixture(x.platform),source=sourceFixture();
 const intent=inferenceInput({text:'synthetic instruction',source:source.source});assert(intent.system_prompt.length<=2048);assert.equal(intent.max_tokens,800);assert.equal(intent.reasoning,false);assert.equal(intent.enable_web_search,false);
 const quote=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>approval(),now});
 const sign=createOperatorSourceSigner({enabled:true,privateStore:source.privateStore,readScope:async()=>scope,readCurrentSource:async()=>source.source,now});
 const evidence=await quote(quoteInput),assets=await sign({...scope,source:source.source,expiresAtMs:10000});
 const permit={permitId:'synthetic-permit-0000000000000000',kind:GENERATION_CONTRACT.version,createdAtMs:1000,expiresAtMs:10000,maximumUsd:.5,counts:GENERATION_CONTRACT.counts,
  source:source.source,sourceSha256:cueDigest((await import('../snapshot/app/runtime/intent-compiler.mjs')).cueSourceIdentity(source.source)),assets,...evidence};
 assert.equal(validatePermit(permit,{now,mediaHost:'example.supabase.co'}),permit);c.connections.close();x.platform.close();
});
function bootstrapFixture({preparation=false}={}){
 const x=sourceFixture();x.evidence.originKind='owner-supplied-bootstrap';delete x.evidence.providerReceipt;
 x.source.music.profile={method:'pcm-endpoint-profile-v1',assetSha256:x.source.music.sha256,frameCount:24*44100,
  sampleRate:44100,channels:2,nonfiniteSamples:0,clippedFraction:0,loudness:{truePeakDbtp:-10},activity:{effectiveSilence:false,maxQuietRunSeconds:0}};
 for(const record of x.records.values())record.provenance={kind:'owner-supplied-bootstrap',actualGenerationThisRun:false};
 if(preparation)x.source.playback={actual:false,phase:'PREPARING',revision:0,playedUntilFrame:0};
 const selected={...scope,kind:'server-selected-source-start-v1',mode:'bootstrap',serverQC:true,
  qcEvidenceSha256:cueDigest({evidence:x.evidence,profile:x.source.music.profile}),sourceSha256:cueDigest(cueSourceIdentity(x.source)),
  source:{...structuredClone(x.source),playback:{actual:false,phase:'IDLE',revision:0,playedUntilFrame:0}}};
 const configuration={audioAssetId:x.source.audioAssetId,audioSha256:x.source.music.sha256,
  referenceAssetId:x.source.referenceAssetId,referenceSha256:x.source.video.referenceSha256};
 const sign=createOperatorSourceSigner({enabled:true,privateStore:x.privateStore,readScope:async()=>scope,readCurrentSource:async()=>x.source,
  readPreparationSource:async()=>x.source,
  readBootstrapAuthority:async()=>selected,bootstrapConfiguration:configuration,now});
 return {...x,selected,configuration,sign};
}
test('approved preparation signs honest unplayed material; provider phases survive24s while Stop, scope and proof still deny',async()=>{
 const x=bootstrapFixture({preparation:true}),assets=await x.sign({...scope,source:x.source,expiresAtMs:40000});
 assert.equal(x.source.playback.actual,false);assert.equal(assets.context.bootstrapEvidence.kind,'verified-owner-bootstrap-preparation-v1');
 assert.equal(assets.context.bootstrapEvidence.playedUntilFrame,0);
 const permit={permitId:'synthetic-preparation-permit-0000',kind:GENERATION_CONTRACT.version,createdAtMs:1000,expiresAtMs:40000,
  maximumUsd:.5,counts:GENERATION_CONTRACT.counts,source:structuredClone(x.source),sourceSha256:cueDigest(cueSourceIdentity(x.source)),assets,
  quote:{verified:true,evidenceSha256:'a'.repeat(64),observedAtMs:1000,maximumUsd:{intent:.01,music:.05,video:.4}},balance:{usd:2,autoTopUp:false,observedAtMs:1000}};
 let time=1000,stopped=false,scopeNow={...scope};const operationId='synthetic-preparation-operation-00';
 const metadata={...scope,permitId:permit.permitId,revoked:false,permitSha256:cueDigest(permit),expiresAtMs:40000};
 const authority=createDispatchAuthority({enabled:true,now:()=>time,mediaHost:'example.supabase.co',readScope:async()=>scopeNow,
  readCurrentSource:()=>assert.fail('preparation must not demand a live source'),readPreparationSource:async()=>x.source,readPermitScope:async()=>metadata,
  repository:{request:async action=>action==='permit'?permit:action==='cueState'?{roomId:scope.roomId,stopped}:
   {operationId,dispatchAllowed:true,stopped:false,permit}}});
 const input={roomId:scope.roomId,ownerCapability:'b'.repeat(64),operationId,permitId:permit.permitId};
 time=31000;
 for(const phase of ['begin-before','initial-intent-before','initial-intent-after','submit-before-provider','poll-before-result','qc-after-publish'])
  assert.equal((await authority.assert({...input,phase})).phase,phase);
 assert.equal(validatePermit(permit,{now:()=>time,mediaHost:'example.supabase.co'}),permit);
 const spoof=structuredClone(permit);spoof.assets.context.providerOriginVerified=true;
 assert.throws(()=>validatePermit(spoof,{now:()=>time,mediaHost:'example.supabase.co'}),/VERIFIED_CONTEXT/);
 const fakeLive=structuredClone(x.source);fakeLive.playback={...fakeLive.playback,actual:true,phase:'PLAYING',playedUntilFrame:256};
 assert.equal(verifiedBootstrapContext(assets.context,fakeLive,{now:()=>time,expiresAtMs:40000}),false);
 stopped=true;await assert.rejects(authority.assert({...input,phase:'poll-before-result'}),/GLOBAL_STOP/);stopped=false;
 scopeNow={...scope,controlRevision:1};await assert.rejects(authority.assert({...input,phase:'poll-before-result'}),/SOURCE_CHANGED|PERMIT_CHANGED/);
 scopeNow={...scope};time=50000;await assert.rejects(authority.assert({...input,phase:'poll-before-result'}),/SCOPE_CHANGED/);
});
test('initial approved owner source produces honest private evidence and a scope-bound permit accepted by live authority',async()=>{
 const x=bootstrapFixture(),assets=await x.sign({...scope,source:x.source,expiresAtMs:10000});
 assert.equal(x.signs(),2);assert.equal(assets.context.providerOriginVerified,false);assert.equal(assets.context.originKind,'owner-supplied-bootstrap');
 const permit={permitId:'synthetic-permit-0000000000000000',kind:GENERATION_CONTRACT.version,createdAtMs:1000,expiresAtMs:10000,
  maximumUsd:.5,counts:GENERATION_CONTRACT.counts,source:structuredClone(x.source),sourceSha256:cueDigest(cueSourceIdentity(x.source)),assets,
  quote:{verified:true,evidenceSha256:'a'.repeat(64),observedAtMs:1000,maximumUsd:{intent:.01,music:.05,video:.4}},
  balance:{usd:2,autoTopUp:false,observedAtMs:1000}};
 assert.equal(validatePermit(permit,{now,mediaHost:'example.supabase.co'}),permit);
 const operationId='synthetic-operation-0000000000';
 const authority=createDispatchAuthority({enabled:true,now,mediaHost:'example.supabase.co',readScope:async()=>scope,
  readCurrentSource:async()=>x.source,readPermitScope:async()=>({...scope,permitId:permit.permitId,revoked:false,permitSha256:cueDigest(permit),expiresAtMs:10000}),
  repository:{request:async action=>action==='permit'?permit:action==='cueState'?{roomId:scope.roomId,stopped:false}:null}});
 const input={roomId:scope.roomId,ownerCapability:'b'.repeat(64),operationId,permitId:permit.permitId,phase:'begin-before'};
 assert.equal((await authority.assert(input)).permitId,permit.permitId);
 const observed=x.source.playback.playedUntilFrame;x.source.playback.playedUntilFrame=0;
 await assert.rejects(authority.assert(input),/SOURCE_CHANGED/);x.source.playback.playedUntilFrame=observed;
 const proof=permit.assets.context.bootstrapEvidence;proof.controlRevision=1;const {evidenceSha256,...body}=proof;proof.evidenceSha256=cueDigest(body);
 await assert.rejects(authority.assert(input),/SOURCE_CHANGED/);
});
test('bootstrap signer refuses wrong authority, approval, native profile, frontier and physical bytes before any URL issuance',async()=>{
 const changes=[
  x=>{x.selected.roomId='33333333-3333-4333-a333-333333333333';},x=>{x.selected['sessionId']='different-epoch';},
  x=>{x.selected.controlRevision=1;},x=>{x.selected.qcEvidenceSha256='a'.repeat(64);},x=>{x.selected.serverQC=false;},
  x=>{x.selected.source.music.sha256='a'.repeat(64);},x=>{x.configuration.audioSha256='a'.repeat(64);},
  x=>{x.configuration.referenceSha256='a'.repeat(64);},x=>{x.configuration.referenceAssetId='wrong-ref';},
  x=>{x.source.music.profile.sampleRate=48000;},x=>{x.source.music.profile.channels=1;},x=>{x.source.music.profile.frameCount=23*44100;},
  x=>{x.source.music.profile.activity.maxQuietRunSeconds=1;},x=>{x.source.playback.actual=false;},
  x=>{x.source.playback.revision=1;},x=>{x.source.playback.playedUntilFrame=0;},x=>{x.source.playback.phase='STAGING';},
  x=>{x.evidence.providerReceipt={requestId:'forged'};},x=>{x.records.get(x.source.audioAssetId).provenance.kind='provider';},
  x=>{x.records.get(x.source.contextAssetId).bytes[44]^=1;},x=>{x.records.get(x.source.referenceAssetId).bytes[0]^=1;}
 ];
 for(const change of changes){const x=bootstrapFixture();change(x);await assert.rejects(x.sign({...scope,source:x.source,expiresAtMs:10000}));assert.equal(x.signs(),0);}
 const x=bootstrapFixture();await assert.rejects(x.sign({...scope,source:x.source,expiresAtMs:1000}));assert.equal(x.signs(),0);
});
test('private bootstrap validator denies forged flags, expired evidence and every altered source binding',async()=>{
 const x=bootstrapFixture(),assets=await x.sign({...scope,source:x.source,expiresAtMs:10000}),original=assets.context;
 assert(verifiedBootstrapContext(original,x.source,{now,expiresAtMs:10000,scope}));
 for(const patch of [{parentSha256:'a'.repeat(64)},{contextSha256:'a'.repeat(64)},{referenceSha256:'a'.repeat(64)},
  {profileSha256:'a'.repeat(64)},{sourceSha256:'a'.repeat(64)},{parentAssetId:'wrong-parent'},{contextAssetId:'wrong-context'},
  {referenceAssetId:'wrong-reference'},{roomId:'another-room'},{['sessionId']:'another-epoch'},{controlRevision:1},
  {expiresAtMs:1000},{playbackRevision:1},{playedUntilFrame:0}]){
  const context=structuredClone(original);Object.assign(context.bootstrapEvidence,patch);
  const {evidenceSha256,...body}=context.bootstrapEvidence;context.bootstrapEvidence.evidenceSha256=cueDigest(body);
  assert.equal(verifiedBootstrapContext(context,x.source,{now,expiresAtMs:10000,scope}),false);
 }
 for(const patch of [{providerOriginVerified:true},{originKind:'provider'},{bootstrapEvidence:{verified:true}}])
  assert.equal(verifiedBootstrapContext({...original,...patch},x.source,{now,expiresAtMs:10000,scope}),false);
});
test('saved-video resolver rechecks private bytes, immutable receipt and exact same-reference generation ledger',async()=>{
 const x=sourceFixture(),bytes=Uint8Array.of(1,2,3),op={operationId:'synthetic-video-operation',submissionId:'synthetic-submission',permit:{source:{video:{referenceSha256:x.source.video.referenceSha256}}},plan:{commonIntentSha256:'1'.repeat(64),common:{control:{version:1}}},stages:{video:{state:'COMPLETE',requestId:'synthetic-request',result:{providerObserved:true,resultSha256:'2'.repeat(64)}}}};
 const binding=operationBinding(scope.roomId,op,'video'),p={kind:'provider',operationId:op.operationId,modelId:GENERATION_CONTRACT.video,requestId:op.stages.video.requestId,resultSha256:op.stages.video.result.resultSha256,sourceSha256:x.source.video.referenceSha256};
 const r={assetId:'synthetic-video',bytes,byteLength:bytes.length,sha256:fixtureSha(bytes),contentType:'video/mp4',binding,provenance:p};x.records.set(r.assetId,r);
 const receipt={...p,version:INGESTION_RECEIPT_VERSION,roomId:scope.roomId,channel:'video',assetId:r.assetId,sha256:r.sha256,binding};receipt.receiptSha256=cueDigest(receipt);const resolve=createSavedVideoResolver({enabled:true,assetStore:x.assetStore,receiptStore:{read:async()=>receipt},readOperation:async()=>op,readScope:async()=>scope,approvedAssetIds:[r.assetId]});
 assert.equal((await resolve({...scope,sha256:r.sha256,referenceSha256:p.sourceSha256})).provenance.requestId,p.requestId);
 receipt.requestId='changed';await assert.rejects(resolve({...scope,sha256:r.sha256,referenceSha256:p.sourceSha256}),/PROVENANCE_REQUIRED/);
});

test('explicit existing-credit approval accepts ON only with fresh API balance safely above the trigger',async()=>{
 const x=platformFixture(),c=connectionFixture(x.platform),a=approval();
 a.autoTopUp=true;a.topUpProtection={kind:'existing-credit-only-v1',approved:true,thresholdUsd:.4,topUpAmountUsd:50,maximumSpendUsd:1.5,observedAtMs:1000,evidenceSha256:'a'.repeat(64)};
 const quote=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>a,now});
 const q=await quote(quoteInput);assert.equal(q.balance.autoTopUp,true);assert.equal(q.balance.topUpProtection.thresholdUsd,.4);
 a.topUpProtection.thresholdUsd=.5;await assert.rejects(quote(quoteInput),/EXISTING_BALANCE/);
 a.topUpProtection.thresholdUsd=.4;
 const manual=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>a,balanceMode:'manual-attested',now});
 await assert.rejects(manual(quoteInput),/SAFETY_APPROVAL/);
 c.connections.close();x.platform.close();
});

test('dashboard balance is a distinct explicit source and never a silent API fallback',async()=>{
 const x=platformFixture(),c=connectionFixture(x.platform),a=approval();a.autoTopUp=true;
 a.topUpProtection={kind:'existing-credit-only-v1',approved:true,thresholdUsd:.4,topUpAmountUsd:50,maximumSpendUsd:1.5,observedAtMs:1000,evidenceSha256:'a'.repeat(64)};
 a.manualBalanceSource='fal-dashboard-observation-v1';
 const quote=createFalQuoteAndBalance({enabled:true,platform:x.platform,connections:c.connections,readSafetyApproval:async()=>a,balanceMode:'manual-attested',now});
 const value=await quote(quoteInput);assert.equal(value.balance.source,'manual-account-attestation');assert.equal(value.balance.autoTopUp,true);
 a.manualBalanceUsd=1.9;await assert.rejects(quote(quoteInput),/EXISTING_BALANCE/);
 c.connections.close();x.platform.close();
});
