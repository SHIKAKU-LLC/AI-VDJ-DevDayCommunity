import {randomUUID} from 'node:crypto';
import {cueDigest,cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {GENERATION_CONTRACT,validatePermit} from '../generation/dispatch.mjs';
import {acceptsFundedBalance} from '../generation/funded-balance.mjs';
import {isBootstrapPreparationSource} from '../generation/bootstrap-source-contract.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const same=(a,b)=>['roomId','sessionId','controlRevision'].every(k=>a?.[k]===b?.[k]);
const scoped=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const missing={connection:'接続 resolver の設定が未完です。',media:'private 素材 upload の設定が未完です。',trial:'有限試験 operator の設定が未完です。'};
const next=kind=>({kind:'configure',target:kind,label:kind==='connection'?'管理者に接続 resolver の設定を依頼':kind==='media'?'管理者に private upload の設定を依頼':'管理者に有限試験 operator の設定を依頼'});
export function countOperatorTrialCredits({plan,priorPlan,playback,runtime}={}){
 if(!plan||!Array.isArray(plan.operations)||!Array.isArray(playback?.cues)||!Array.isArray(runtime?.acks))return 0;
 let operations=plan.operations;
 if(plan.participants===3){
  if(!same(plan,priorPlan)||priorPlan?.planId!==plan.priorPlanId||priorPlan.participants!==2||priorPlan.phase!=='STARTED'||!Array.isArray(priorPlan.operations))return 0;
  operations=[...priorPlan.operations,...operations];
 }
 return new Set(operations.filter(o=>playback.cues.some(c=>c.operationId===o.operationId&&c.contribution?.participantId===o.participantId&&
  ['PLAYING','PLAYED'].includes(c.status)&&c.playbackRevision>0)&&runtime.acks.some(a=>a.reservation?.operationId===o.operationId&&
  a.reservation.cue?.contribution?.participantId===o.participantId)).map(o=>o.participantId)).size;
}
async function body(request){
 const reader=request.body?.getReader(),parts=[];let length=0;
 try{if(reader)for(;;){const p=await reader.read();if(p.done)break;length+=p.value.length;if(length>65536)fail('OPERATOR_BODY_LIMIT');parts.push(p.value);}
 const b=Buffer.concat(parts,length);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
 finally{await reader?.cancel().catch(()=>{});}
}
/** Configuration supplies opaque, scoped resolvers. This factory never stores a
 * credential, discovers an ambient key or opens a provider connection on import.
 * Admission/plan claims must be durable in production; RAM ports are fixture-only.
 */
export function createOwnerOperator({enabled=false,mode='production',origin,roomId,authorizeOwner,readScope,macRequired=false,serverManaged=false,
 connections,media,trial,approvals={},now=Date.now,mintId=randomUUID}={}){
 if(typeof enabled!=='boolean'||!['production','fixture'].includes(mode)||typeof authorizeOwner!=='function'||typeof readScope!=='function')fail('OPERATOR_CONFIGURATION_REQUIRED');
 const available={connection:enabled&&approvals.connection===true&&(typeof connections?.capabilities!=='function'||connections.capabilities().ready===true)&&['connect','read'].every(k=>typeof connections?.[k]==='function'),
 media:enabled&&approvals.media===true&&(typeof media?.capabilities!=='function'||media.capabilities().ready===true)&&['begin','append','finish','read'].every(k=>typeof media?.[k]==='function'),
 trial:enabled&&approvals.trial===true&&(mode==='fixture'||typeof connections?.forOperation==='function')&&['readSubmissions','readSource','quoteAndBalance','signSource','insertPermits','beginOperation','readProgress'].every(k=>typeof trial?.[k]==='function')&&
 ['save','read','claim','record','active'].every(k=>typeof trial?.plans?.[k]==='function')};
 available.trial&&=available.connection&&available.media;
 const participantCounts=trial?.maximumParticipants===5&&trial?.maximumCents===250?[2,3,5]:[2,3];
 if(serverManaged)participantCounts.unshift(1);
 let closed=false;
 const gate=kind=>{if(closed||!available[kind])fail('OPERATOR_'+kind.toUpperCase()+'_NOT_CONFIGURED');};
 async function scope(){const s=await readScope({roomId});if(s.roomId!==roomId||s.closed||s.ownerEnabled!==true||s.expiresAtMs<=now())fail('OPERATOR_SCOPE_CHANGED');return s;}
 async function stable(s){const latest=await scope();if(!same(s,latest)||latest.expiresAtMs!==s.expiresAtMs)fail('OPERATOR_SCOPE_CHANGED');}
 function safeConnection(c,s){if(!c||!same(c,s)||!id(c.connectionId)||c.verified!==true||!Number.isSafeInteger(c.expiresAtMs)||c.expiresAtMs<=now())fail('OPERATOR_CONNECTION_REQUIRED');
 return {connectionId:c.connectionId,verified:true,expiresAtMs:c.expiresAtMs};}
 function safeAsset(a,s){if(!a||!same(a,s)||!id(a.assetId)||!sha(a.sha256)||!Number.isSafeInteger(a.byteLength)||a.byteLength<1||a.byteLength>32*1024*1024||
 !['seed','reference','saved-video'].includes(a.role)||a.privateSaved!==true||a.checksumVerified!==true||a.serverQC!==true)fail('OPERATOR_ASSET_REQUIRED');
 return Object.fromEntries(['assetId','sha256','byteLength','mimeType','role','referenceSha256'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));}
 const state=()=>({version:'owner-operator-v1',mode,available:{...available},actualProviderVerified:false,
 persistentCredentialStorage:false,macRequired:macRequired===true,...(serverManaged?{serverManaged:true}:{}),providerMaximumCentsPerPerson:50,participants:[...participantCounts],
 infrastructure:{configured:trial?.infrastructure?.verified===true,maximumUsd:trial?.infrastructure?.maximumUsd??null},
 blockers:Object.keys(available).filter(k=>!available[k]).map(k=>({target:k,reason:missing[k],nextAction:next(k)})),
 nextAction:Object.keys(available).some(k=>!available[k])?next(Object.keys(available).find(k=>!available[k])):{kind:'input',target:'connection',label:'接続を検証する'}});
 async function connection(input,s){gate('connection');if(!exact(input,['credential'])||typeof input.credential!=='string'||input.credential.length<8||input.credential.length>4096)fail('OPERATOR_CREDENTIAL_REQUIRED');
 let c;try{c=await connections.connect({...scoped(s),credential:input.credential});}finally{input.credential='';}
 await stable(s);return {phase:'CONNECTED',mode,...safeConnection(c,s),nextAction:{kind:'select',target:'media',label:'送信する素材を選ぶ'}};}
 async function upload(action,input,s){gate('media');
 if(action==='begin'){
  if(!exact(input,['role','mimeType','byteLength','sha256','referenceSha256','consent'])||input.consent!==true||!sha(input.sha256)||
   !['seed','reference','saved-video'].includes(input.role)||!Number.isSafeInteger(input.byteLength)||input.byteLength<1||input.byteLength>32*1024*1024||
   !({seed:['audio/wav'],reference:['image/png','image/jpeg'],'saved-video':['video/mp4']}[input.role].includes(input.mimeType))||
   input.role==='saved-video'&&!sha(input.referenceSha256))fail('OPERATOR_SELECTION_REQUIRED');
  const u=await media.begin({...scoped(s),selection:{...input}});await stable(s);
  if(!id(u?.uploadId)||u.chunkBytes!==32768)fail('OPERATOR_UPLOAD_REQUIRED');return {uploadId:u.uploadId,chunkBytes:32768,phase:'UPLOADING',mode};
 }
 if(action==='chunk'){
  if(!exact(input,['uploadId','offset','data'])||!id(input.uploadId)||!Number.isSafeInteger(input.offset)||input.offset<0||typeof input.data!=='string'||
   input.data.length>43692||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))fail('OPERATOR_CHUNK_REQUIRED');
  const bytes=Buffer.from(input.data,'base64');if(!bytes.length||bytes.length>32768||bytes.toString('base64')!==input.data)fail('OPERATOR_CHUNK_REQUIRED');
  const r=await media.append({...scoped(s),uploadId:input.uploadId,offset:input.offset,bytes});await stable(s);
  if(r?.receivedBytes!==input.offset+bytes.length)fail('OPERATOR_CHUNK_REQUIRED');return {receivedBytes:r.receivedBytes};
 }
 if(!exact(input,['uploadId'])||!id(input.uploadId))fail('OPERATOR_UPLOAD_REQUIRED');
 const a=safeAsset(await media.finish({...scoped(s),uploadId:input.uploadId}),s);await stable(s);
 return {phase:'SAVED',asset:a,mode,nextAction:{kind:'review',target:'trial',label:'2人の試験予算を確認する'}};
 }
 async function prepare(input,s){gate('trial');gate('connection');gate('media');
 if(!exact(input,['connectionId','assetIds','participants','maximumCents','priorPlanId'])||!id(input.connectionId)||
 !participantCounts.includes(input.participants)||input.maximumCents!==input.participants*50||!Array.isArray(input.assetIds)||input.assetIds.length<3||input.assetIds.length>10||
 input.assetIds.some(v=>!id(v))||new Set(input.assetIds).size!==input.assetIds.length)fail('OPERATOR_TRIAL_REQUIRED');
 if(trial.infrastructure?.verified!==true||!Number.isFinite(trial.infrastructure.maximumUsd)||trial.infrastructure.maximumUsd<0)fail('OPERATOR_INFRASTRUCTURE_REQUIRED');
 const c=safeConnection(await connections.read({...scoped(s),connectionId:input.connectionId}),s);
 const assets=await Promise.all(input.assetIds.map(async assetId=>safeAsset(await media.read({...scoped(s),assetId}),s)));
 if(assets.filter(a=>a.role==='seed').length!==1||assets.filter(a=>a.role==='reference').length!==1||!assets.some(a=>a.role==='saved-video'))fail('OPERATOR_ASSET_REQUIRED');
 const ref=assets.find(a=>a.role==='reference');if(assets.some(a=>a.role==='saved-video'&&a.referenceSha256!==ref.sha256))fail('OPERATOR_REFERENCE_CHANGED');
 let prior=null;if(input.participants===3){if(!id(input.priorPlanId))fail('OPERATOR_TWO_PERSON_FIRST');prior=await trial.plans.read({...scoped(s),planId:input.priorPlanId});
 const progress=await trial.readProgress({...scoped(s),plan:prior});
 if(!same(prior,s)||prior.participants!==2||prior.phase!=='STARTED'||progress.completedParticipants!==2||prior.connectionId!==c.connectionId||cueDigest(prior.assets)!==cueDigest(assets))fail('OPERATOR_TWO_PERSON_FIRST');
 }else if(input.priorPlanId!==null)fail('OPERATOR_TRIAL_REQUIRED');
 const source=await trial.readSource({...scoped(s),assets});if(source?.playback?.actual!==true&&!isBootstrapPreparationSource(source))fail('OPERATOR_OUTPUT_REQUIRED');const sourceSha256=cueDigest(cueSourceIdentity(source));
 const evidence=await trial.quoteAndBalance({...scoped(s),connectionId:c.connectionId,models:{...GENERATION_CONTRACT},participants:input.participants});
 if(trial.infrastructure?.verified!==true||!Number.isFinite(trial.infrastructure.maximumUsd)||trial.infrastructure.maximumUsd<0)fail('OPERATOR_INFRASTRUCTURE_REQUIRED');
 const rates=['intent','music','video'].map(k=>evidence?.quote?.maximumUsd?.[k]);
 if(evidence?.quote?.verified!==true||!sha(evidence.quote.evidenceSha256)||rates.some(v=>!Number.isFinite(v)||v<=0)||rates.reduce((a,b)=>a+b,0)>.5||
 !Number.isSafeInteger(evidence.quote.observedAtMs)||now()-evidence.quote.observedAtMs<0||now()-evidence.quote.observedAtMs>3600000||
 !acceptsFundedBalance(evidence.balance,{now,requiredUsd:input.maximumCents/100})||!Number.isSafeInteger(evidence.balance.observedAtMs)||now()-evidence.balance.observedAtMs<0||now()-evidence.balance.observedAtMs>3600000)fail('OPERATOR_PRICE_BALANCE_REQUIRED');
 const candidates=await trial.readSubmissions(scoped(s));if(!Array.isArray(candidates)||candidates.length>100||candidates.some(x=>!id(x.submissionId)||!id(x.participantId)))fail('OPERATOR_SUBMISSIONS_REQUIRED');
 const previousIds=prior?.operations.map(o=>o.submissionId)??[],participantIds=new Set(prior?.operations.map(o=>o.participantId)??[]),count=prior?1:input.participants,selected=[];
 for(const item of candidates){if(!participantIds.has(item.participantId)&&!previousIds.includes(item.submissionId)){participantIds.add(item.participantId);selected.push(item);if(selected.length===count)break;}}
 // Preserve a positive balance even if the approved maximum is fully spent.
 if(!Number.isFinite(evidence?.balance?.usd)||evidence.balance.usd<=input.maximumCents/100)fail('OPERATOR_BALANCE_REQUIRED');
 if(selected.length!==count)fail('OPERATOR_SUBMISSIONS_REQUIRED');
 const expiresAtMs=Math.floor(Math.min(now()+3600000,s.expiresAtMs,c.expiresAtMs)/1000)*1000;
 if(expiresAtMs<=now())fail('OPERATOR_CONNECTION_REQUIRED');
 const operations=selected.map(item=>{const operationId='operator-'+mintId(),permitId='permit-'+mintId(),permit={permitId,kind:GENERATION_CONTRACT.version,
 connectionId:c.connectionId,counts:{...GENERATION_CONTRACT.counts},createdAtMs:now(),expiresAtMs,maximumUsd:.5,source,sourceSha256,
 quote:evidence.quote,balance:evidence.balance,...(evidence.visualPolicy?{visualPolicy:evidence.visualPolicy}:{})};
 return {operationId,permitId,submissionId:item.submissionId,participantId:item.participantId,permit};});
 await stable(s);const planId='trial-'+mintId(),plan={...scoped(s),planId,phase:'REVIEW',participants:input.participants,priorPlanId:input.priorPlanId,
 connectionId:c.connectionId,assets,sourceSha256,expiresAtMs,maximumCents:input.maximumCents,infrastructureMaximumUsd:trial.infrastructure.maximumUsd,operations,previousIds};
 await trial.plans.save(plan);return {phase:'REVIEW',mode,planId,participants:plan.participants,newParticipants:operations.length,maximumCents:plan.maximumCents,
 infrastructureMaximumUsd:trial.infrastructure.maximumUsd,models:{intent:GENERATION_CONTRACT.intent,music:GENERATION_CONTRACT.music,video:GENERATION_CONTRACT.video},
 counts:{intent:operations.length,music:operations.length,video:operations.length},expiresAtMs,nextAction:{kind:'approve',target:'trial',label:'表示した予算で試験を開始する'}};
 }
 async function start(input,s){gate('trial');if(!exact(input,['planId','consent','maximumCents'])||!id(input.planId)||input.consent!==true)fail('OPERATOR_TRIAL_CONSENT_REQUIRED');
 const plan=await trial.plans.read({...scoped(s),planId:input.planId});if(!same(plan,s)||plan.phase!=='REVIEW'||plan.expiresAtMs<=now()||plan.maximumCents!==input.maximumCents)fail('OPERATOR_PLAN_CHANGED');
 safeConnection(await connections.read({...scoped(s),connectionId:plan.connectionId}),s);
 if(trial.infrastructure?.verified!==true||trial.infrastructure.maximumUsd!==plan.infrastructureMaximumUsd)fail('OPERATOR_INFRASTRUCTURE_REQUIRED');
 const fresh=await trial.quoteAndBalance({...scoped(s),connectionId:plan.connectionId,models:{...GENERATION_CONTRACT},participants:plan.participants});
 if(!acceptsFundedBalance(fresh?.balance,{now,requiredUsd:plan.maximumCents/100})||fresh.balance.usd<=plan.maximumCents/100)fail('OPERATOR_BALANCE_REQUIRED');
 const assets=await Promise.all(plan.assets.map(async a=>safeAsset(await media.read({...scoped(s),assetId:a.assetId}),s)));
 if(cueDigest(assets)!==cueDigest(plan.assets))fail('OPERATOR_ASSET_CHANGED');
 const source=await trial.readSource({...scoped(s),assets:plan.assets});if(source?.playback?.actual!==true&&!isBootstrapPreparationSource(source))fail('OPERATOR_OUTPUT_REQUIRED');if(cueDigest(cueSourceIdentity(source))!==plan.sourceSha256)fail('OPERATOR_SOURCE_CHANGED');
 const signed=await trial.signSource({...scoped(s),source,assets:plan.assets,expiresAtMs:plan.expiresAtMs});
 for(const o of plan.operations){o.permit={...o.permit,quote:fresh.quote,balance:fresh.balance,assets:signed};validatePermit(o.permit,{now,mediaHost:trial.mediaHost});}await stable(s);
 // One durable admission before any permit/initial POST. Lost results hold;
 // start is never automatically replayed. A status read reconciles the plan.
 if(trial.reserveBudget)await trial.reserveBudget({...scoped(s),plan:structuredClone(plan)});
 if(await trial.plans.claim({...scoped(s),planId:plan.planId})!==true)fail('OPERATOR_PLAN_ALREADY_CLAIMED');
 try{await trial.insertPermits({...scoped(s),plan});for(const o of plan.operations){await stable(s);await trial.beginOperation({...scoped(s),connectionId:plan.connectionId,...o});}
 await trial.plans.record({...scoped(s),planId:plan.planId,phase:'STARTED'});return {phase:'STARTED',mode,planId:plan.planId,participants:plan.participants,
 actualProviderVerified:false,nextAction:{kind:'observe',target:'trial',label:'試験の生成・QC・採用状態を確認する'}};
 }catch{await trial.plans.record({...scoped(s),planId:plan.planId,phase:'UNKNOWN'}).catch(()=>{});fail('OPERATOR_START_UNKNOWN');}
 }
 function review(plan){return {phase:'REVIEW',mode,planId:plan.planId,participants:plan.participants,newParticipants:plan.operations.length,
 maximumCents:plan.maximumCents,infrastructureMaximumUsd:plan.infrastructureMaximumUsd,expiresAtMs:plan.expiresAtMs,
 models:{intent:GENERATION_CONTRACT.intent,music:GENERATION_CONTRACT.music,video:GENERATION_CONTRACT.video},
 counts:{intent:plan.operations.length,music:plan.operations.length,video:plan.operations.length}};}
 async function status(s){const result=state();let selections=[];
 if(available.media&&typeof media.listSelected==='function'){
  selections=await (media.listSelectedForStatus??media.listSelected).call(media,s);
  result.assets=selections.map(a=>safeAsset(a,s));
 }
 if(available.connection&&typeof connections.readActive==='function'){
  const active=await connections.readActive(scoped(s));if(active)result.connection=safeConnection(active,s);
 }
 if(available.trial){const plan=await trial.plans.active(scoped(s));if(plan){
  if(!same(plan,s))fail('OPERATOR_SCOPE_CHANGED');const progress=await trial.readProgress({...scoped(s),plan});
  if(!result.connection&&available.connection)result.connection=safeConnection(await connections.read({...scoped(s),connectionId:plan.connectionId}),s);
  result.trial={planId:plan.planId,phase:plan.phase,participants:plan.participants,completedParticipants:progress.completedParticipants,
    canAddThird:plan.participants===2&&plan.phase==='STARTED'&&progress.completedParticipants===2};
  // Status displays the already admitted immutable descriptors. Spending still
  // uses start()/signSource and its physical media reads, never this cache.
  result.assets=await Promise.all(plan.assets.map(async a=>{
   const saved=selections.find(d=>d.assetId===a.assetId&&d.sha256===a.sha256&&d.byteLength===a.byteLength&&
    d.role===a.role&&(a.role!=='saved-video'||d.referenceSha256===a.referenceSha256));
   return safeAsset(saved??await media.read({...scoped(s),assetId:a.assetId}),s);
  }));
  if(plan.phase==='REVIEW')result.plan=review(plan);
  result.nextAction={kind:'refresh',target:'trial',label:'同じ試験の状態を確認する'};
 }}await stable(s);return result;
 }
 async function handleRequest(request){const path=new URL(request.url).pathname,match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/operator\/(status|connection|media\/(begin|chunk|finish)|trial\/(prepare|start|status))$/i);if(!match)return null;
 const proof=request.headers.get('x-room-owner'),from=request.headers.get('origin');
 if(match[1]!==roomId||from!==origin&&!(request.method==='GET'&&from===null&&request.headers.get('sec-fetch-site')==='same-origin')||
 !sha(proof)||request.headers.has('authorization')||request.headers.has('x-fal-key'))return reply({error:'OWNER_OR_ORIGIN_DENIED'},403);
 try{if(await authorizeOwner({roomId,ownerCapability:proof})!==true)fail('OWNER_DENIED');const s=await scope();
 if(match[2]==='status'){if(request.method!=='GET')return reply({error:'GET_REQUIRED'},405);return reply(await status(s));}
 if(match[2]==='trial/status'){gate('trial');if(request.method!=='POST')return reply({error:'POST_REQUIRED'},405);const input=await body(request);
 if(!exact(input,['planId'])||!id(input.planId))fail('OPERATOR_TRIAL_REQUIRED');const plan=await trial.plans.read({...scoped(s),planId:input.planId});
 if(!same(plan,s))fail('OPERATOR_PLAN_CHANGED');const progress=await trial.readProgress({...scoped(s),plan});await stable(s);
 return reply({phase:plan.phase,mode,planId:plan.planId,participants:plan.participants,completedParticipants:progress.completedParticipants,
 canAddThird:plan.participants===2&&plan.phase==='STARTED'&&progress.completedParticipants===2,nextAction:{kind:'refresh',target:'trial',label:'試験状態を確認する'}});}
 if(request.method!=='POST')return reply({error:'POST_REQUIRED'},405);
 const kind=match[2]==='connection'?'connection':match[3]?'media':'trial';gate(kind);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'JSON_REQUIRED'},415);
 const input=await body(request);return reply(match[2]==='connection'?await connection(input,s):match[3]?await upload(match[3],input,s):match[4]==='prepare'?await prepare(input,s):await start(input,s));
 }catch(e){const known=['OPERATOR_CONNECTION_REQUIRED','OPERATOR_SCOPE_CHANGED','OPERATOR_OUTPUT_REQUIRED','OPERATOR_EXISTING_TRIAL','OPERATOR_PRICE_BALANCE_REQUIRED','OPERATOR_BALANCE_REQUIRED','OPERATOR_TWO_PERSON_FIRST','OPERATOR_SUBMISSIONS_REQUIRED','OPERATOR_INFRASTRUCTURE_REQUIRED','OPERATOR_PLAN_ALREADY_CLAIMED','OPERATOR_START_UNKNOWN','OPERATOR_BILLING_PERMISSION_REQUIRED','OPERATOR_OPERATIONAL_APPROVAL_REQUIRED','OPERATOR_PRICE_APPROVAL_REQUIRED','OPERATOR_SOURCE_ORIGIN_REQUIRED','OWNER_DENIED'];
 const k=match[2]==='connection'?'connection':match[3]?'media':'trial',code=known.includes(e.code)?e.code:available[k]?'OPERATOR_HOLD':'OPERATOR_'+k.toUpperCase()+'_NOT_CONFIGURED';
 return reply({error:code,reason:missing[k],nextAction:next(k)},code==='OWNER_DENIED'?403:409);}}
 return Object.freeze({handleRequest,capabilities:state,close(){closed=true;}});
}
