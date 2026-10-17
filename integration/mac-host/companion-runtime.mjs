import {createOwnerCloudConnection} from '../runtime/owner-cloud-connection.mjs';
import {createMacEdgeTrialRuntime} from './edge-trial-composition.mjs';
import {APPROVED_KEYCHAIN_ITEM} from './keychain-provider.mjs';
import {buildEdgeTrialOperatorConfiguration,readEdgeTrialConfiguration,isPersistentCompanionConsent} from './edge-trial-operator-config.mjs';
import {publicProviderMetadata} from './edge-trial-native-orchestrator.mjs';
const fail=()=>{throw Error('COMPANION_RUNTIME_HOLD');};
const same=(a,b)=>['roomId','sessionId','controlRevision'].every(k=>a?.[k]===b?.[k]);
// Existing production host supplies generation, Cue, measured QC, observer,
// durable scheduler and Auto DJ. This wrapper only restores the native device
// and activation context; reconnect never calls jobs/start or operator/start.
export function createMacCompanionRuntime({roomId,projectURL,deviceStore,policy,store,readCurrent,signal,
  configuration={},onDiagnostic=()=>{},readOperationalApproval,writeRegistration=async()=>{},writeMetadata=async()=>{},
  createRuntime=createMacEdgeTrialRuntime,fetchImpl=globalThis.fetch,now=Date.now,keychainReadItem}={}){
  if(policy?.approved!==true||policy.roomId!==roomId||!deviceStore?.identity||
    typeof readOperationalApproval!=='function')fail();
  const owner=createOwnerCloudConnection({roomId,projectURL,fetchImpl,signal,now});
  let runtime,closed=false,initializing,initialized=false,stage='owner',state='pending',deadline,registration,configured=false,preparing,configuring;
  const active=()=>{if(closed||signal?.aborted||deadline!==undefined&&now()>=deadline)fail();};
  async function prepare(){
    if(!policy.mediaUploadApproved||runtime?.status().nativeBootstrapReady||!readCurrent()?.audioAssetId)return;
    // Share one preparation across owner status polls. A later local source
    // selection can still be prepared without restarting or reenrolling.
    if(!preparing)preparing=(async()=>{stage='bootstrap';await runtime.prepareNativeBootstrap();active();})();
    try{await preparing;}finally{preparing=undefined;}
  }
  async function operational(){
    if(configured){stage='complete';return;}
    if(!runtime||policy.providerUseApproved!==true)return;
    if(!configuring)configuring=(async()=>{
      stage='operational-approval';
      try{await runtime.configureNativeTrial();active();configured=true;state='ready';stage='complete';}
      catch(error){active();state='pending';onDiagnostic({event:'COMPANION_CONFIGURATION_HOLD',reason:[error,error?.cause,error?.cause?.cause,error?.cause?.cause?.cause,error?.cause?.cause?.cause?.cause].filter(Boolean).map(e=>/^[A-Z0-9_]{1,100}$/.test(e?.message??'')?e.message:'FAILED').join(':')});}
    })();
    try{await configuring;}finally{configuring=undefined;}
  }
  async function initialize(input){
    try{
      active();stage='scope';
      const response=await fetchImpl(projectURL+'/functions/v1/ai-vdj-room/api/rooms/'+roomId+'/runtime/scope',{
        method:'POST',headers:{origin:'https://ai-vdj.vercel.app','content-type':'application/json','x-room-owner':input.ownerCapability},
        body:'{}',credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
      if(!response.ok||response.redirected)fail();const scope=await response.json();active();
      const snapshot=await owner.readCloud();active();
      if(!same(scope,snapshot)||scope.roomId!==roomId||!Number.isSafeInteger(scope.expiresAtMs)||
        scope.expiresAtMs<=now()||scope.expiresAtMs>now()+14400000&&policy.implementationRoomNoExpiryApproved!==true)fail();
      // Only the explicitly approved implementation room may outlive a normal
      // room. Its native session/Keychain authorization stays bounded to4h.
      deadline=Math.min(scope.expiresAtMs,now()+14400000);stage='registration';
      const identity=await deviceStore.identity(roomId);active();
      const base=buildEdgeTrialOperatorConfiguration({readOperationalApproval,roomId,expiresAtMs:deadline,companion:true,projectURL,now});
      runtime=createRuntime({roomId,projectURL,enabled:true,expiresAtMs:deadline,companion:true,identity,store,readCurrent,signal,
        configuration:{...configuration,onDiagnostic,operatorConfiguration:base},fetchImpl,now,keychainReadItem,
        writeRegistration:async value=>{registration=value;await writeRegistration({...identity,sign:undefined},value);},
        readActivation:async value=>{
          active();if(value.workerId!==identity.workerId||value.publicKeySha256!==identity.publicKeySha256)fail();
          let connectionId;
          try{const saved=await readOperationalApproval(value);
            if(saved.version==='owner-companion-operation-v1'&&saved.approved===true&&same(saved,value)&&
              (isPersistentCompanionConsent(saved)||saved.expiresAtMs>now()&&saved.expiresAtMs<=deadline)&&
              /^[A-Za-z0-9_-]{1,100}$/.test(saved.connectionId))connectionId=saved.connectionId;
          }catch{}
          return {approved:true,registration:value,...(policy.providerUseApproved?{keychainApproval:{...value,
            ...APPROVED_KEYCHAIN_ITEM,approved:true,policy:'owner-companion-v1',
            process:'ai-vdj-native-node',recipient:'fal-fixed-generation-and-platform',...(connectionId?{connectionId}:{})}}:{})};
        },
        readOperationalConfiguration:value=>readEdgeTrialConfiguration({readOperationalApproval,registration:value,roomId,
          expiresAtMs:deadline,companion:true,projectURL,now})});
      await runtime.attachOwner(input);active();await runtime.prepareRegistration();active();
      stage='activation';await runtime.activateNative();active();
      if(policy.providerUseApproved){stage='provider-metadata';const raw=await runtime.readProviderMetadata();active();
        const metadata=publicProviderMetadata(raw,{roomId,registration,expiresAtMs:deadline,now});
        await writeMetadata(metadata);active();if(metadata.balanceError){
          // A billing-permission failure never upgrades the key. Only an
          // explicitly selected, validated dashboard observation can replace it.
          const fallback=await readEdgeTrialConfiguration({readOperationalApproval,registration,roomId,
            expiresAtMs:deadline,companion:true,projectURL,now});
          if(fallback.operatorConfiguration.adapters.balanceMode!=='manual-attested')fail();
        }}
      await prepare();active();
      state='pending';await operational();initialized=true;
    }catch(error){if(!closed){state='hold';onDiagnostic({event:'COMPANION_HOLD',reason:stage+':'+[error,error?.cause,error?.cause?.cause,error?.cause?.cause?.cause,error?.cause?.cause?.cause?.cause].filter(Boolean).map(e=>/^[A-Z0-9_]{1,100}$/.test(e?.message??'')?e.message:'FAILED').join(':')});}}
  }
  return Object.freeze({
    async attachOwner(input){active();await owner.attachOwner(input);active();
      if(state==='hold'){await runtime?.close();runtime=undefined;deadline=undefined;initializing=undefined;initialized=false;configured=false;state='pending';}
      if(runtime){await runtime.attachOwner(input);active();}
      if(!initializing)initializing=initialize(input);return this.status();},
    async readCloud(){active();const value=runtime?await runtime.readCloud():await owner.readCloud();active();
      // Status polling must not configure the host while initialization is
      // still preparing its source, or overwrite an initialization failure.
      if(initialized&&state!=='hold')try{await prepare();await operational();}catch{state='hold';}
      return value;},
    status(){const value=runtime?.status()??owner.status();return {...value,
      connected:!closed&&!signal?.aborted&&value.connected,runtimeActivated:value.runtimeActivated===true&&state==='ready',registrationRestored:!!runtime,
      nativeOrchestration:{state:closed?'closed':deadline!==undefined&&now()>=deadline?'expired':state,stage},
      ...(deadline?{expiresAtMs:deadline}:{})};},
    async handleProductionRequest(request){active();if(!runtime)fail();
      if(policy.providerUseApproved&&!runtime.status().nativeBootstrapReady)return Response.json({error:state==='hold'?'COMPANION_HOLD':'COMPANION_PREPARING'},{status:503});
      return runtime.handleProductionRequest(request);},
    async close(){closed=true;owner.close();await runtime?.close();await initializing?.catch(()=>{});await runtime?.close();},
  });
}
