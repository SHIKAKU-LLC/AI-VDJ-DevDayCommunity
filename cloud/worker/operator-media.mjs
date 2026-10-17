import {randomUUID,createHash} from 'node:crypto';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {decodeCompleteWave} from '../../integration/runtime/bootstrap.mjs';
import {assessTechnicalVisual} from '../../integration/qc/visual-policy.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=c=>{throw Object.assign(Error(c),{code:c});};
const fields=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
const same=(a,b)=>cueDigest(fields(a))===cueDigest(fields(b));
/** Ephemeral bounded upload assembly; accepted assets are physically persisted
 * through the existing private store. Restart discards incomplete uploads only.
 * A saved-video provenance resolver is mandatory; owner selection cannot forge
 * provider origin/reference/QC. No public upload, file name or broad URL exists.
 */
export function createOperatorMedia({enabled=false,assetStore,inspectAudio,inspectReference,inspectVideo,verifySavedVideo,
 ownerBootstrapVideoApproved=false,beforeBegin,onSelectedAsset,readScope,now=Date.now}={}){
 if(!assetStore?.save||!assetStore?.read||!assetStore?.verifySaved||typeof readScope!=='function')fail('OPERATOR_MEDIA_PORTS_REQUIRED');
 let closed=false;const uploads=new Map(),finishing=new Map();let reserved=0,selectedCache=null;
 const remember=(scope,descriptor)=>{if(!['seed','reference','saved-video'].includes(descriptor.role))return;
  const assets=selectedCache&&same(selectedCache.scope,scope)?selectedCache.assets.filter(a=>a.role!==descriptor.role):[];
  selectedCache={scope:structuredClone(scope),assets:[...assets,structuredClone(descriptor)]};};
 const active=async s=>{if(!enabled||closed)fail('OPERATOR_MEDIA_NOT_CONFIGURED');const current=await readScope({roomId:s.roomId});
 if(!same(s,current)||current.ownerEnabled!==true||current.expiresAtMs<=now()||
 s.expiresAtMs!==undefined&&s.expiresAtMs!==current.expiresAtMs)fail('OPERATOR_SCOPE_CHANGED');return current;};
 const indexId=(s,role)=>'operator-selection-'+cueDigest({...fields(s),role}).slice(0,48);
 async function physical(assetId,sha256){const r=await assetStore.read(assetId),p=await assetStore.verifySaved({binding:r.binding,asset:{assetId,sha256}});
  if(r.assetId!==assetId||r.sha256!==sha256||hash(r.bytes)!==sha256||r.byteLength!==r.bytes.length||p.privateSaved!==true||p.checksumVerified!==true||
   p.assetId!==assetId||p.sha256!==sha256||cueDigest(p.binding)!==cueDigest(r.binding))fail('OPERATOR_CHECKSUM_CHANGED');return r;}
 async function readDescriptor(input){await active(input);const metadataId='selection-'+input.assetId,meta=await assetStore.read(metadataId);
  if(meta.contentType!=='application/json'||meta.provenance?.kind!=='operator-selected-private-asset'||meta.bytes.length>65536)fail('OPERATOR_ASSET_REQUIRED');
  await physical(metadataId,meta.sha256);let d;try{d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(meta.bytes));}catch{fail('OPERATOR_ASSET_REQUIRED');}
  if(!d||!same(d,input)||d.assetId!==input.assetId||d.expiresAtMs!==undefined&&d.expiresAtMs!==(await active(input)).expiresAtMs)fail('OPERATOR_ASSET_REQUIRED');
  const stored=await physical(d.assetId,d.sha256);
  if(stored.byteLength!==d.byteLength||stored.contentType!==d.mimeType)fail('OPERATOR_ASSET_REQUIRED');
  if(stored.provenance?.kind==='owner-supplied-bootstrap-video'){
   const p=stored.provenance,b=stored.binding,m=await physical('admission-'+p.admissionId,p.admissionEvidenceSha256);
   let evidence;try{evidence=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(m.bytes));}catch{fail('OPERATOR_VIDEO_QC_REQUIRED');}
   const current=await active(input);
   if(!same(b,current)||b.expiresAtMs!==current.expiresAtMs||b.kind!=='owner-supplied-bootstrap-video'||
    p.actualGenerationThisRun!==false||p.rawSha256!==d.sha256||p.sourceSha256!==d.referenceSha256||
    m.contentType!=='application/json'||m.provenance.kind!=='owner-bootstrap-video-admission'||cueDigest(m.binding)!==cueDigest(b)||
    evidence.version!=='owner-bootstrap-video-admission-v1'||evidence.assetId!==d.assetId||evidence.sha256!==d.sha256||
    evidence.byteLength!==d.byteLength||evidence.referenceSha256!==d.referenceSha256||evidence.admissionId!==p.admissionId||
    evidence.ownerSelected!==true||evidence.actualGenerationThisRun!==false||cueDigest(evidence.binding)!==cueDigest(b)||
    evidence.measurement?.rawSha256!==d.sha256||evidence.measurement.fullyDecoded!==true||evidence.measurement.durationSeconds<19||
    evidence.measurement.inputDigest!==cueDigest({kind:'operator-upload-video-v1',sha256:d.sha256,referenceSha256:d.referenceSha256})||
    !assessTechnicalVisual(evidence.measurement).passed)fail('OPERATOR_VIDEO_QC_REQUIRED');
  }
  await active(input);return structuredClone(d);}
 // An existing role selection is immutable. Resolve it from the deterministic
 // index so callers can decide BEFORE persisting any new private bytes.
 async function existingSelection(scope,d){
  if(!['seed','reference','saved-video'].includes(d.role))return null;
  const id=indexId(scope,d.role),previous=await (assetStore.readOptional??assetStore.read).call(assetStore,id);if(!previous)return null;
  await physical(id,previous.sha256);let selected;try{selected=JSON.parse(new TextDecoder().decode(previous.bytes));}catch{fail('OPERATOR_SOURCE_CHANGED');}
  const prior=await readDescriptor({...fields(scope),assetId:selected.assetId});
  if(prior.sha256!==d.sha256||prior.role!==d.role||d.role==='saved-video'&&prior.referenceSha256!==d.referenceSha256)fail('OPERATOR_SOURCE_CHANGED');
  return prior;
 }
 async function adoptExisting(scope,prior){
  await onSelectedAsset?.({scope:structuredClone(scope),descriptor:structuredClone(prior)});await active(scope);remember(scope,prior);return prior;
 }
 async function persistSelection(scope,d,assetId){
  const stored=await physical(assetId,d.sha256);await active(scope);
  const descriptor={...fields(scope),expiresAtMs:scope.expiresAtMs,assetId,sha256:d.sha256,byteLength:stored.byteLength,mimeType:d.mimeType,role:d.role,
   ...(d.role==='saved-video'?{referenceSha256:d.referenceSha256}:{}),privateSaved:true,checksumVerified:true,serverQC:true};
  const metadataId='selection-'+assetId,metadataBytes=new TextEncoder().encode(JSON.stringify(descriptor));
  await assetStore.save({id:metadataId,bytes:metadataBytes,contentType:'application/json',binding:{kind:'owner-supplied-bootstrap'},
   provenance:{kind:'operator-selected-private-asset',actualGenerationThisRun:false}});
  if(['seed','reference','saved-video'].includes(d.role)){
   // Still rechecked here: a concurrent finish may have written the index.
   const prior=await existingSelection(scope,descriptor);if(prior)return adoptExisting(scope,prior);
   await assetStore.save({id:indexId(scope,d.role),bytes:new TextEncoder().encode(JSON.stringify({assetId})),contentType:'application/json',binding:{kind:'owner-supplied-bootstrap'},
    provenance:{kind:'operator-selected-private-asset',actualGenerationThisRun:false}});
  }
  await active(scope);await onSelectedAsset?.({scope:structuredClone(scope),descriptor:structuredClone(descriptor)});await active(scope);remember(scope,descriptor);return descriptor;
 }
 async function verifyInput(bytes,d){
  if(d.role==='seed'){
   const wave=decodeCompleteWave(bytes);if(wave.frames!==24*44100||typeof inspectAudio!=='function')fail('OPERATOR_SEED_QC_REQUIRED');
   const p=await inspectAudio(bytes);if(p.assetSha256!==d.sha256||p.frameCount!==24*44100||p.channels!==2||p.sampleRate!==44100||p.nonfiniteSamples!==0||
   !Number.isFinite(p.clippedFraction)||p.clippedFraction<0||p.clippedFraction>.001||!Number.isFinite(p.loudness?.truePeakDbtp)||p.loudness.truePeakDbtp>-.3||p.activity?.effectiveSilence!==false||!Number.isFinite(p.activity.maxQuietRunSeconds)||p.activity.maxQuietRunSeconds<0||p.activity.maxQuietRunSeconds>.5)fail('OPERATOR_SEED_QC_REQUIRED');
  }else if(d.role==='reference'){
   const png=[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
   if(bytes.length>4*1024*1024||!(d.mimeType==='image/png'?png:d.mimeType==='image/jpeg'&&jpeg)||typeof inspectReference!=='function')fail('OPERATOR_REFERENCE_REQUIRED');
   const m=await inspectReference(bytes);
   if(m?.sha256!==d.sha256||m.fullyDecoded!==true||!Number.isSafeInteger(m.width)||m.width<1||m.width>8192||
    !Number.isSafeInteger(m.height)||m.height<1||m.height>8192||m.width*m.height>32*1024*1024)fail('OPERATOR_REFERENCE_REQUIRED');
  }else fail('OPERATOR_SELECTION_REQUIRED');
 }
 function release(id){const u=uploads.get(id);if(u){reserved-=u.selection.byteLength;uploads.delete(id);u.chunks=[];}}
 function collect(scope){for(const [id,u] of uploads)if(u.expiresAtMs<=now()||!same(u,scope))release(id);}
 return Object.freeze({
 capabilities:()=>({ready:enabled&&!closed&&[inspectAudio,inspectReference,inspectVideo,verifySavedVideo].every(f=>typeof f==='function'),staging:'ephemeral-bounded',acceptedAssets:'private-immutable'}),
 async begin(input){const scope=await active(input);collect(scope);const selection=structuredClone(input.selection);
 if(!selection||!Number.isSafeInteger(selection.byteLength)||selection.byteLength<1||selection.byteLength>32*1024*1024||uploads.size>=3||reserved+selection.byteLength>64*1024*1024)fail('OPERATOR_MEDIA_LIMIT');
 if(selection.role==='saved-video'&&typeof verifySavedVideo!=='function')fail('OPERATOR_SAVED_VIDEO_PROVENANCE_REQUIRED');
 await beforeBegin?.({scope:structuredClone(scope),selection:structuredClone(selection)});await active(scope);
 collect(scope);if(uploads.size>=3||reserved+selection.byteLength>64*1024*1024)fail('OPERATOR_MEDIA_LIMIT');
 const uploadId='upload-'+randomUUID();uploads.set(uploadId,{...fields(scope),selection,chunks:[],length:0,expiresAtMs:scope.expiresAtMs});reserved+=selection.byteLength;return {uploadId,chunkBytes:32768};},
 async append(input){const scope=await active(input);const u=uploads.get(input.uploadId);
 if(!u||!same(u,input)||u.expiresAtMs!==scope.expiresAtMs||u.expiresAtMs<=now()||input.offset!==u.length||!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>32768||u.length+input.bytes.length>u.selection.byteLength)fail('OPERATOR_CHUNK_REQUIRED');
 u.chunks.push(Buffer.from(input.bytes));u.length+=input.bytes.length;return {receivedBytes:u.length};},
 async finish(input){const scope=await active(input);const u=uploads.get(input.uploadId);if(!u||!same(u,input)||u.expiresAtMs!==scope.expiresAtMs||u.expiresAtMs<=now()||u.length!==u.selection.byteLength)fail('OPERATOR_UPLOAD_REQUIRED');
 // One host process owns a room's uploads. Finishes for the same role run one
 // at a time, so a concurrent different upload sees the winner's index before
 // QC or any save and never leaves orphaned objects.
 const key=indexId(scope,u.selection.role??'unknown'),previous=finishing.get(key)??Promise.resolve();
 let done;const turn=new Promise(resolve=>{done=resolve;});finishing.set(key,previous.then(()=>turn));
 await previous.catch(()=>{});
 try{const bytes=Buffer.concat(u.chunks),d=u.selection;if(hash(bytes)!==d.sha256)fail('OPERATOR_CHECKSUM_CHANGED');
 // Reject a different replacement, or reuse the identical selection, before
 // QC or any private save so retries never leave unreferenced objects.
 const prior=await existingSelection(scope,d);if(prior)return await adoptExisting(scope,prior);
 // Stable per scope/role/content: a retry after a transient failure reuses the
 // same immutable private object (save is idempotent for identical metadata).
 const assetId='selected-'+cueDigest({...fields(scope),role:d.role,sha256:d.sha256,mimeType:d.mimeType,
  ...(d.role==='saved-video'?{referenceSha256:d.referenceSha256}:{})}).slice(0,48);let binding={kind:'owner-supplied-bootstrap'},provenance={kind:'owner-supplied-bootstrap',actualGenerationThisRun:false};
 if(['seed','reference'].includes(d.role))await verifyInput(bytes,d);
 else if(d.role==='saved-video'){
 const approved=await verifySavedVideo({...fields(u),sha256:d.sha256,referenceSha256:d.referenceSha256});
 if(approved!==null&&(approved?.provenance?.kind!=='provider'||approved.provenance.sourceSha256!==d.referenceSha256||approved.binding?.roomId!==u.roomId)||
 approved===null&&(ownerBootstrapVideoApproved!==true||d.consent!==true)||typeof inspectVideo!=='function')fail('OPERATOR_SAVED_VIDEO_PROVENANCE_REQUIRED');
 const inputDigest=cueDigest({kind:'operator-upload-video-v1',sha256:d.sha256,referenceSha256:d.referenceSha256}),m=await inspectVideo({bytes,inputDigest});
 if(m?.rawSha256!==d.sha256||m.inputDigest!==inputDigest||m.fullyDecoded!==true||!Number.isFinite(m.durationSeconds)||m.durationSeconds<19||
 !Number.isSafeInteger(m.decodedFrames)||m.decodedFrames<2||!Number.isSafeInteger(m.width)||m.width<1||!Number.isSafeInteger(m.height)||m.height<1||
 !assessTechnicalVisual(m).passed)fail('OPERATOR_VIDEO_QC_REQUIRED');
 if(approved){binding=approved.binding;provenance=approved.provenance;}
 else{
  const admissionId='owner-video-'+cueDigest({...fields(scope),assetId}).slice(0,48);binding={kind:'owner-supplied-bootstrap-video',...fields(scope),expiresAtMs:scope.expiresAtMs,referenceSha256:d.referenceSha256};
  const evidence={version:'owner-bootstrap-video-admission-v1',assetId,sha256:d.sha256,byteLength:bytes.length,referenceSha256:d.referenceSha256,
   admissionId,ownerSelected:true,actualGenerationThisRun:false,binding,measurement:m};
  let evidenceBytes=new TextEncoder().encode(JSON.stringify(evidence));if(evidenceBytes.length>65536)fail('OPERATOR_VIDEO_QC_REQUIRED');
  // A retried finish reuses the admission it already saved for these exact
  // bytes/reference/binding; readDescriptor still re-validates its measurement.
  const saved=await assetStore.readOptional?.('admission-'+admissionId);
  if(saved){let prior;try{prior=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(saved.bytes));}catch{fail('OPERATOR_VIDEO_QC_REQUIRED');}
   if(prior?.assetId!==assetId||prior.sha256!==d.sha256||prior.byteLength!==bytes.length||prior.referenceSha256!==d.referenceSha256||
    prior.admissionId!==admissionId||cueDigest(prior.binding)!==cueDigest(binding))fail('OPERATOR_VIDEO_QC_REQUIRED');
   evidenceBytes=Uint8Array.from(saved.bytes);
  }else{await active(scope);await assetStore.save({id:'admission-'+admissionId,bytes:evidenceBytes,contentType:'application/json',binding,
   provenance:{kind:'owner-bootstrap-video-admission',actualGenerationThisRun:false}});}
  provenance={kind:'owner-supplied-bootstrap-video',actualGenerationThisRun:false,sourceSha256:d.referenceSha256,rawSha256:d.sha256,
   admissionId,admissionEvidenceSha256:hash(evidenceBytes)};
 }
 }else fail('OPERATOR_SELECTION_REQUIRED');
 await active(scope);await assetStore.save({id:assetId,bytes,contentType:d.mimeType,binding,provenance});
 // Await inside try: the role turn and staging release follow the full save.
 return await persistSelection(scope,d,assetId);
 }finally{release(input.uploadId);done();}},
 read:readDescriptor,
 async listSelected(input){const scope=await active(input),selected=[];
  for(const role of ['seed','reference','saved-video']){const id=indexId(scope,role),record=await (assetStore.readOptional??assetStore.read).call(assetStore,id);if(!record)continue;
   await physical(id,record.sha256);if(record.contentType!=='application/json'||record.provenance?.kind!=='operator-selected-private-asset')fail('OPERATOR_ASSET_REQUIRED');
   let value;try{value=JSON.parse(new TextDecoder().decode(record.bytes));}catch{fail('OPERATOR_ASSET_REQUIRED');}
   const d=await readDescriptor({...fields(scope),assetId:value.assetId});if(d.role!==role)fail('OPERATOR_ASSET_REQUIRED');selected.push(d);
  }await active(scope);selectedCache={scope:structuredClone(scope),assets:structuredClone(selected)};return selected;},
 // Display only: generation admission still calls read() and verifies physical bytes.
 async listSelectedForStatus(input){const scope=await active(input);
  if(selectedCache&&same(selectedCache.scope,scope)&&selectedCache.scope.expiresAtMs===scope.expiresAtMs)return structuredClone(selectedCache.assets);
  return this.listSelected(input);},
 async registerExisting({scope:input,assetId,role}){const scope=await active(input),r=await assetStore.read(assetId);
  if(!['seed','reference'].includes(role)||r.provenance?.kind!=='owner-supplied-bootstrap'||r.provenance.actualGenerationThisRun!==false)fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
  const d={role,mimeType:r.contentType,sha256:r.sha256,byteLength:r.byteLength};await physical(assetId,r.sha256);await verifyInput(r.bytes,d);return persistSelection(scope,d,assetId);},
 close(){closed=true;selectedCache=null;for(const id of [...uploads.keys()])release(id);}});
}
