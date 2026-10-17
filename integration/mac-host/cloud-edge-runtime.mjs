import {createOwnerCloudConnection} from '../runtime/owner-cloud-connection.mjs';
import {createRuntimeRequestSigner} from '../../cloud/room/runtime-request-proof.mjs';
import {createEdgeRuntimeTransport} from '../../cloud/worker/edge-runtime-transport.mjs';
import {createProductionNativeHost} from '../../cloud/worker/production-host.mjs';
import {createFalPlatformAdapter} from '../../cloud/worker/fal-platform-adapter.mjs';
import {createScopedKeychainProvider,createKeychainOperatorCustodian} from './keychain-provider.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';

// Two-phase manual short trial. Public registration metadata can be approved
// before activation. No DB/platform context exists on this Mac path. Keychain
// activation is a separate explicitly approved native adapter configuration.
export function createMacCloudEdgeSession({roomId,projectURL,enabled=false,fetchImpl=globalThis.fetch,now=Date.now,
 expiresAtMs=now()+1800000,signal,identity,companion=false,createNativeHost=createProductionNativeHost}={}){
 const created=now();if(companion&&!identity)throw Error('COMPANION_IDENTITY_REQUIRED');
 if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=created||expiresAtMs>created+(companion?14400000:1800000)||typeof createNativeHost!=='function')throw Error('EDGE_SESSION_DEADLINE_REQUIRED');
 const abort=new AbortController();
 const owner=createOwnerCloudConnection({roomId,projectURL,fetchImpl,signal:abort.signal,allowRuntimeOwnerContext:enabled,contextExpiresAtMs:expiresAtMs,companion,now});
 let closed=signal?.aborted===true,signer,transport,host,keychain,custodian,platform,closing;
 const ownerRequests=new AsyncLocalStorage();
 // One owner-authenticated native request may contain many signed Edge calls.
 // Reuse only its live callback context; every Edge call still checks the owner,
 // registered device, current room epoch/control and expiry in PostgreSQL.
 // Never retain a completed request's context or share it with another request.
 async function withOwnerAuthorization(scope,invoke){
  const current=ownerRequests.getStore();
  if(current){
   const check=()=>{if(!current.active||closed||abort.signal.aborted||signal?.aborted||now()>=expiresAtMs||
    !scope||scope.roomId!==roomId||Object.keys(scope).some(k=>!['roomId','sessionId','controlRevision'].includes(k))||
    (scope.sessionId!==undefined)!==(scope.controlRevision!==undefined)||scope.sessionId!==undefined&&
    (scope.sessionId!==current.context.sessionId||scope.controlRevision!==current.context.controlRevision)||typeof invoke!=='function')
    throw Error('OWNER_RUNTIME_CONTEXT_HOLD');};
   check();const value=await invoke({...current.context});check();return value;
  }
  return owner.withOwnerAuthorization(scope,async context=>{
   const frame={context:Object.freeze({...context}),active:true};
   try{return await ownerRequests.run(frame,()=>invoke({...context}));}finally{frame.active=false;}
  });
 }
 const close=()=>{closed=true;abort.abort();owner.close();signer?.close();transport?.close();custodian?.close();keychain?.close();platform?.close();
  return closing??=Promise.resolve().then(()=>host?.close());};
 const ended=()=>{void close().catch(()=>{});};signal?.addEventListener('abort',ended,{once:true});
 return Object.freeze({attachOwner:owner.attachOwner,readCloud:owner.readCloud,status:owner.status,
  withOwnerAuthorization,
  async prepareRegistration(){
   if(!enabled||closed||signal?.aborted||now()>=expiresAtMs||signer)throw Error('EDGE_SESSION_PREPARATION_REQUIRED');
   const scope=await owner.withOwnerAuthorization({roomId},async context=>{
    const project=new URL(projectURL);if(project.origin!==projectURL||project.protocol!=='https:'||project.port||!/^[a-z0-9]+\.supabase\.co$/.test(project.hostname))throw Error('EDGE_SESSION_PROJECT_REQUIRED');
    const response=await fetchImpl(projectURL+'/functions/v1/ai-vdj-room/api/rooms/'+roomId+'/runtime/scope',{method:'POST',
     headers:{origin:'https://ai-vdj.vercel.app','content-type':'application/json','x-room-owner':context.ownerCapability},body:'{}',
     redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!response.ok||response.redirected)throw Error('EDGE_SESSION_SCOPE_HOLD');
    const value=await response.json();if(value.roomId!==roomId||value.sessionId!==context.sessionId||value.controlRevision!==context.controlRevision||
     !Number.isSafeInteger(value.expiresAtMs)||value.expiresAtMs<=now())throw Error('EDGE_SESSION_SCOPE_HOLD');return value;
   });
   if(closed||signal?.aborted||now()>=expiresAtMs)throw Error('EDGE_SESSION_SCOPE_HOLD');
   const prepared=await createRuntimeRequestSigner({enabled:true,scope,now,expiresAtMs:Math.min(expiresAtMs,scope.expiresAtMs),...(companion?{identity}: {})});
   if(closed||signal?.aborted||now()>=expiresAtMs){prepared.close();throw Error('EDGE_SESSION_SCOPE_HOLD');}
   signer=prepared;
   transport=createEdgeRuntimeTransport({enabled:true,roomId,projectURL,withOwnerAuthorization,signer,fetchImpl,now});
   return signer.registration();
  },
  async activateNative({approved=false,configuration,keychainApproval,keychainReadItem}={}){
   if(!approved||!enabled||closed||signal?.aborted||now()>=expiresAtMs||!transport||host||!configuration||
    ['createPool','readConnection','withPlatformHeaders','edgeTransport','withOwnerAuthorization'].some(k=>Object.hasOwn(configuration,k)))
    throw Error('EDGE_SESSION_ACTIVATION_REQUIRED');
   // This proves the pinned Edge worker was approved before constructing native
   // inspectors or invoking any provider/Keychain callback.
   await transport.repository.query((await import('../../cloud/jobs/repository-statements.mjs')).EXISTING_REPOSITORY_SELECTS.scope,[roomId]);
   if(closed||signal?.aborted||now()>=expiresAtMs)throw Error('EDGE_SESSION_SCOPE_HOLD');
   let operatorConfiguration=configuration.operatorConfiguration;
   if(keychainApproval){
    if(keychainApproval.approved!==true||keychainApproval.expiresAtMs>signer.registration().expiresAtMs)throw Error('KEYCHAIN_APPROVAL_REQUIRED');
    const readScope=async input=>host.io.repositoryPorts.readScope(input);
    keychain=createScopedKeychainProvider({enabled:true,approval:keychainApproval,readScope,readItem:keychainReadItem,now});
    platform=createFalPlatformAdapter({enabled:true,fetchImpl,now});
    custodian=createKeychainOperatorCustodian({enabled:true,keychain,platform,readScope,now,
     expiresAtMs:keychainApproval.expiresAtMs,connectionId:keychainApproval.connectionId,runtimeExpiresAtMs:signer.registration().expiresAtMs});
    operatorConfiguration={...operatorConfiguration,enabled:true,adapters:{...operatorConfiguration?.adapters,enabled:true,custodian},
     approvals:{...operatorConfiguration?.approvals,connection:true}};
   }
   // The owner's own output page is the trusted playback clock for live shows
   // (decided 2026-10-16); see docs/THIRD-PARTY-REVIEW-20261016.md.
   host=createNativeHost({showMode:true,...configuration,operatorConfiguration,enabled:true,roomId,projectURL,edgeTransport:transport,
    runBackground:callback=>ownerRequests.run(null,callback),
    withOwnerAuthorization,fetchImpl,now});
   try{await host.start();if(closed||signal?.aborted||now()>=expiresAtMs)throw Error('EDGE_SESSION_SCOPE_HOLD');return host;}
   catch{await close();throw Error('EDGE_SESSION_ACTIVATION_HOLD');}
  },
  async readProviderMetadata(){
   if(closed||signal?.aborted||now()>=expiresAtMs||!host||!custodian||!platform)throw Error('EDGE_PROVIDER_METADATA_HOLD');
   const scope=await host.io.repositoryPorts.readScope({roomId}),connection=await custodian.readActive(scope);
   const metadata=await custodian.withCredential({...scope,connectionId:connection.connectionId},async key=>{
    const pricing=await platform.prices(key);let balance=null,balanceError=null;
    try{balance=await platform.balance(key);}catch{balanceError='FAL_BALANCE_HOLD';}
    return {...pricing,balance,balanceError};
   });
   if(closed||signal?.aborted||now()>=expiresAtMs)throw Error('EDGE_PROVIDER_METADATA_HOLD');
   return {...metadata,connectionId:connection.connectionId,expiresAtMs:connection.expiresAtMs,
    autoTopUpVerified:false,generationInvoked:false};
  },
  async configureApprovedOperator({connectionId,operatorConfiguration}={}){
   if(closed||signal?.aborted||now()>=expiresAtMs||!host||!custodian)throw Error('EDGE_OPERATOR_CONFIGURATION_HOLD');
   const scope=await host.io.repositoryPorts.readScope({roomId});await custodian.read({...scope,connectionId});
   if(closed||signal?.aborted||now()>=expiresAtMs)throw Error('EDGE_OPERATOR_CONFIGURATION_HOLD');
   return host.configureApprovedOperator({connectionId,operatorConfiguration});
  },
  registration:()=>signer?.registration()??null,
  async close(){signal?.removeEventListener('abort',ended);await close();},
 });
}
