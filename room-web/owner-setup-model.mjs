const roles=['seed','reference','saved-video'];
const mime={seed:['audio/wav'],reference:['image/png','image/jpeg'],'saved-video':['video/mp4']};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const encode=bytes=>{let s='';for(const n of bytes)s+=String.fromCharCode(n);return btoa(s);};
export function ownerSetupMaterialsComplete(materials){
 if(!Array.isArray(materials)||materials.length!==roles.length||roles.some(role=>materials.filter(a=>a?.role===role).length!==1))return false;
 const reference=materials.find(a=>a.role==='reference');
 return sha(reference.sha256)&&materials.find(a=>a.role==='saved-video').referenceSha256===reference.sha256;
}
const combinedMaterials=state=>[...state.assets.filter(a=>!state.selections.some(s=>s.role===a.role)),...state.selections];
function acceptedAssets(value){
 if(!Array.isArray(value)||value.length>3||value.some(a=>!id(a?.assetId)||!roles.includes(a.role)||!sha(a.sha256)||
  !Number.isSafeInteger(a.byteLength)||a.byteLength<1||a.byteLength>32*1024*1024||!mime[a.role].includes(a.mimeType)||
  a.role==='saved-video'&&!sha(a.referenceSha256))||new Set(value.map(a=>a.role)).size!==value.length)fail('OPERATOR_ASSET_REQUIRED');
 return value.map(a=>Object.fromEntries(['assetId','sha256','byteLength','mimeType','role','referenceSha256']
  .filter(key=>a[key]!==undefined).map(key=>[key,a[key]])));
}
// Successful status/material updates can make native output available before
// budget review. Serialize refreshes so repeated view draws cannot recurse or
// fetch the same capability state while an operation is still busy.
export function createOwnerSetupCapabilityRefresh({refresh,isCurrent=()=>true,onError=()=>{}}={}){
 if(typeof refresh!=='function')fail('OPERATOR_CLIENT_REQUIRED');
 let pending=null,applied=null,running=false;
 async function drain(){
  if(running||!isCurrent())return;
  running=true;
  try{while(pending!==null&&isCurrent()){
   const signature=pending;pending=null;if(signature===applied)continue;
   try{if(await refresh()!==false)applied=signature;}catch{onError();}
  }}finally{running=false;}
 }
 return Object.freeze({observe(state){
  if(!isCurrent()||state.busy||state.error&&state.error!=='OPERATOR_OUTPUT_REQUIRED')return;
  const assets=state.assets??[];
  if(['seed','reference'].some(role=>assets.filter(a=>a.role===role&&sha(a.sha256)&&id(a.assetId)).length!==1))return;
  const signature=JSON.stringify({assets:assets.map(a=>[a.role,a.assetId,a.sha256]).sort((a,b)=>a[0].localeCompare(b[0])),
   macRequired:state.macRequired===true,media:state.available?.media===true,trial:state.available?.trial===true});
  if(signature===applied||signature===pending)return;
  pending=signature;void drain();
 }});
}
export function createOwnerSetupModel({request,roomId,mintId=()=>crypto.randomUUID()}={}){
 if(typeof request!=='function')fail('OPERATOR_CLIENT_REQUIRED');
 let closed=false,busy=false,epoch=0;const files=new Map(),listeners=new Set();
 let state={phase:'LOADING',mode:null,macRequired:false,available:{connection:false,media:false,trial:false},blockers:[],connection:null,selections:[],assets:[],plan:null,trial:null,error:null,nextAction:null};
 const snapshot=()=>structuredClone({...state,busy,selectionComplete:ownerSetupMaterialsComplete(combinedMaterials(state)),
  assetsComplete:ownerSetupMaterialsComplete(state.assets)});
 const emit=()=>{const s=snapshot();for(const l of listeners)l(s);};
 const endpoint='/api/rooms/'+roomId+'/operator/';
 async function call(path,body){if(closed)fail('OPERATOR_CLOSED');return request(endpoint+path,body===undefined?{method:'GET'}:{method:'POST',body});}
 async function run(action){if(closed||busy)fail('OPERATOR_BUSY');busy=true;state.error=null;emit();const revision=epoch;
 try{const result=await action();if(closed||epoch!==revision)fail('OPERATOR_CLOSED');emit();return result;}
 catch(error){if(!closed){state.error=/^OPERATOR_[A-Z_]+$/.test(error?.code??error?.message??'')?(error.code??error.message):'OPERATOR_HOLD';
 if(state.error==='OPERATOR_CONNECTION_REQUIRED')state.connection=null;
 const steps={OPERATOR_REFERENCE_FIRST:{kind:'select',target:'media',label:'先に参照画像を選ぶ'},OPERATOR_OUTPUT_REQUIRED:{kind:'output',target:'output',label:'映像・音声出力を開き、音声を有効にする'},OPERATOR_INFRASTRUCTURE_REQUIRED:{kind:'configure',target:'infrastructure',label:'管理者に配備先と費用上限の確認を依頼'},OPERATOR_TWO_PERSON_FIRST:{kind:'refresh',target:'trial',label:'先に2人の採用状態を確認する'},OPERATOR_EXISTING_TRIAL:{kind:'refresh',target:'trial',label:'開始済みの試験状態を確認する'}};
 steps.OPERATOR_SOURCE_ORIGIN_REQUIRED={kind:'configure',target:'source-origin',label:'管理者に初期音声の出自契約を確認する'};
 steps.OPERATOR_SOURCE_FIXED={kind:'select',target:'media',label:'確認済みの初期音声・参照画像を使い、対応する保存映像を選ぶ'};
 for(const code of ['OPERATOR_BILLING_PERMISSION_REQUIRED','OPERATOR_OPERATIONAL_APPROVAL_REQUIRED','OPERATOR_PRICE_APPROVAL_REQUIRED','OPERATOR_BALANCE_REQUIRED'])steps[code]={kind:'configure',target:'trial-evidence',label:'管理者に直前の価格・残高・Auto top-up設定の確認を依頼'};
 state.nextAction=steps[state.error]??state.nextAction;emit();}throw Error(state.error??'OPERATOR_CLOSED');}
 finally{busy=false;if(!closed)emit();}}
 const next=value=>{state.nextAction=value?.nextAction??state.nextAction;};
 function gate(kind){if(!state.available[kind])fail('OPERATOR_'+kind.toUpperCase()+'_NOT_CONFIGURED');}
 const api={snapshot,subscribe(fn){listeners.add(fn);fn(snapshot());return()=>listeners.delete(fn);},
 changeParticipants(){if(closed||busy)return false;if(state.plan?.phase==='REVIEW')state.plan=null;emit();return true;},
 load:()=>run(async()=>{const c=await call('status');if(c?.version!=='owner-operator-v1'||!['fixture','production'].includes(c.mode)||
 ['connection','media','trial'].some(k=>typeof c.available?.[k]!=='boolean')||c.macRequired!==undefined&&typeof c.macRequired!=='boolean')fail('OPERATOR_STATUS_REQUIRED');
 const accepted=acceptedAssets(c.assets??state.assets);
 const restored=new Set(state.selections.filter(s=>accepted.some(a=>a.role===s.role&&a.sha256===s.sha256&&a.byteLength===s.byteLength&&
  (s.role!=='saved-video'||a.referenceSha256===s.referenceSha256))).map(s=>s.selectionId));
 for(const selectionId of restored)files.delete(selectionId);
 state.selections=state.selections.filter(s=>!restored.has(s.selectionId));
 const assets=accepted.filter(a=>!state.selections.some(s=>s.role===a.role||s.role==='reference'&&a.role==='saved-video'));
 state={...state,phase:'READY',mode:c.mode,macRequired:c.macRequired===true,serverManaged:c.serverManaged===true,available:{...c.available},participants:c.participants??[2,3],blockers:c.blockers??[],infrastructure:c.infrastructure,connection:c.connection??state.connection,assets,
  plan:state.selections.length?null:c.resumePlan??c.plan??state.plan,trial:state.selections.length?null:c.trial??state.trial};next(c);}),
 connect:credential=>run(async()=>{gate('connection');if(state.macRequired)fail('OPERATOR_CONNECTION_MANAGED_AT_MAC');if(typeof credential!=='string'||credential.length<8||credential.length>4096)fail('OPERATOR_CREDENTIAL_REQUIRED');
 let c;try{c=await call('connection',{credential});}finally{credential='';}
 if(c?.phase!=='CONNECTED'||!id(c.connectionId)||c.verified!==true||!Number.isSafeInteger(c.expiresAtMs))fail('OPERATOR_CONNECTION_REQUIRED');
 state.connection={connectionId:c.connectionId,verified:true,expiresAtMs:c.expiresAtMs};state.plan=null;state.trial=null;next(c);}),
 select:({role,file})=>run(async()=>{if(!roles.includes(role)||!file||!mime[role].includes(file.type)||!Number.isSafeInteger(file.size)||file.size<1||file.size>32*1024*1024)fail('OPERATOR_SELECTION_REQUIRED');
 const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length!==file.size)fail('OPERATOR_SELECTION_REQUIRED');
 const png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(role==='seed'&&(String.fromCharCode(...bytes.slice(0,4))!=='RIFF'||String.fromCharCode(...bytes.slice(8,12))!=='WAVE')||
 role==='reference'&&(file.type==='image/png'?!png:!jpeg)||role==='saved-video'&&String.fromCharCode(...bytes.slice(4,8))!=='ftyp')fail('OPERATOR_FILE_FORMAT_REQUIRED');
 const selectionId='selection-'+mintId(),sha256=await hash(bytes),referenceSha256=role==='saved-video'?
  state.selections.find(s=>s.role==='reference')?.sha256??state.assets.find(a=>a.role==='reference')?.sha256??null:null;
 const fixed=role!=='saved-video'&&state.assets.find(a=>a.role===role);
 if(fixed){if(fixed.sha256!==sha256)fail('OPERATOR_SOURCE_FIXED');return;}
 if(role==='saved-video'&&!referenceSha256)fail('OPERATOR_REFERENCE_FIRST');
 for(const old of state.selections.filter(s=>s.role===role||role==='reference'&&s.role==='saved-video'))files.delete(old.selectionId);
 state.selections=state.selections.filter(s=>s.role!==role&&!(role==='reference'&&s.role==='saved-video'));
 state.selections.push({selectionId,role,mimeType:file.type,byteLength:bytes.length,sha256,referenceSha256});files.set(selectionId,bytes);
 state.assets=state.assets.filter(a=>a.role!==role&&!(role==='reference'&&a.role==='saved-video'));state.plan=null;state.trial=null;state.nextAction={kind:'upload',target:'media',label:'選んだ素材の送信先を確認する'};}),
 upload:consent=>run(async()=>{gate('media');if(consent!==true||!state.selections.length||!ownerSetupMaterialsComplete(combinedMaterials(state)))fail('OPERATOR_SELECTION_REQUIRED');
 for(const role of roles){const selection=state.selections.find(s=>s.role===role);if(!selection)continue;
 const bytes=files.get(selection.selectionId);
 if(!bytes||await hash(bytes)!==selection.sha256)fail('OPERATOR_SELECTION_CHANGED');
 const {selectionId,...descriptor}=selection,u=await call('media/begin',{...descriptor,consent:true});
 if(!id(u.uploadId)||u.chunkBytes!==32768)fail('OPERATOR_UPLOAD_REQUIRED');
 for(let offset=0;offset<bytes.length;offset+=u.chunkBytes){const chunk=bytes.subarray(offset,offset+u.chunkBytes),r=await call('media/chunk',{uploadId:u.uploadId,offset,data:encode(chunk)});
 if(r.receivedBytes!==offset+chunk.length)fail('OPERATOR_CHUNK_REQUIRED');}
 const result=await call('media/finish',{uploadId:u.uploadId}),a=result.asset;
 if(result.phase!=='SAVED'||!id(a?.assetId)||a.sha256!==selection.sha256||a.byteLength!==selection.byteLength||a.role!==selection.role||
  a.role==='saved-video'&&a.referenceSha256!==selection.referenceSha256)fail('OPERATOR_ASSET_REQUIRED');
 state.assets=[...state.assets.filter(old=>old.role!==role),...acceptedAssets([a])];
 state.selections=state.selections.filter(old=>old.selectionId!==selection.selectionId);files.delete(selection.selectionId);next(result);}
 state.plan=null;state.trial=null;}),
 prepare:participants=>run(async()=>{gate('trial');if(!state.connection||state.selections.length||!ownerSetupMaterialsComplete(state.assets)||!(state.participants??[2,3]).includes(participants)||participants===3&&state.trial?.canAddThird!==true)fail('OPERATOR_TRIAL_REQUIRED');
 const p=await call('trial/prepare',{connectionId:state.connection.connectionId,assetIds:state.assets.map(a=>a.assetId),participants,
 maximumCents:participants*50,priorPlanId:participants===3?state.trial.planId:null});
 if(p.phase!=='REVIEW'||!id(p.planId)||p.participants!==participants||p.maximumCents!==participants*50||!Number.isFinite(p.infrastructureMaximumUsd))fail('OPERATOR_PLAN_CHANGED');
 state.plan=p;next(p);}),
 start:consent=>run(async()=>{gate('trial');const p=state.plan;if(consent!==true||p?.phase!=='REVIEW')fail('OPERATOR_TRIAL_CONSENT_REQUIRED');
 try{const result=await call(p.resume===true?'resume':'trial/start',{planId:p.planId,maximumCents:p.maximumCents,consent:true});
 if(result.phase!=='STARTED'||result.planId!==p.planId)fail('OPERATOR_START_UNKNOWN');state.plan={...p,phase:'STARTED'};state.trial={...result,canAddThird:false};next(result);
 }catch(error){if(['OPERATOR_SOURCE_ORIGIN_REQUIRED','OPERATOR_BILLING_PERMISSION_REQUIRED','OPERATOR_OPERATIONAL_APPROVAL_REQUIRED','OPERATOR_PRICE_APPROVAL_REQUIRED','OPERATOR_BALANCE_REQUIRED'].includes(error?.code)){state.plan={...p,phase:'HOLD'};fail(error.code);}
 state.plan={...p,phase:'UNKNOWN'};state.trial={planId:p.planId,phase:'UNKNOWN',canAddThird:false};state.nextAction={kind:'refresh',target:'trial',label:'送信済みの試験状態を確認する'};fail('OPERATOR_START_UNKNOWN');}}),
 refresh:()=>run(async()=>{const planId=state.trial?.planId??state.plan?.planId;if(!id(planId))fail('OPERATOR_TRIAL_REQUIRED');const r=await call('trial/status',{planId});
 if(r.planId!==planId||!['REVIEW','CLAIMED','STARTED','UNKNOWN'].includes(r.phase)||!Number.isSafeInteger(r.completedParticipants))fail('OPERATOR_PLAN_CHANGED');
 state.trial=r;state.plan={...state.plan,phase:r.phase};next(r);}),
 dispose(){closed=true;epoch++;files.clear();listeners.clear();state.connection=null;state.assets=[];state.selections=[];state.plan=null;state.trial=null;}}
 return Object.freeze(api);
}
