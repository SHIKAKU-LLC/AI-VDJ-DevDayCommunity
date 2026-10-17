import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {GENERATION_CONTRACT} from '../../cloud/generation/dispatch.mjs';
import {createEdgeTrialNativeOrchestrator,createPrivateMetadataWriter,
 publicProviderMetadata} from './edge-trial-native-orchestrator.mjs';

const roomId='71ae8719-2ceb-4308-a019-bbc9ff4b6f5d';
const registration={roomId,['sessionId']:'11111111-1111-1111-1111-111111111111',controlRevision:2};
const now=()=>1_000_000;
const expiresAtMs=1_050_000;
const metadata={prices:['intent','music','video'].map(key=>({endpointId:GENERATION_CONTRACT[key],
 unit:'unit',unitPrice:0.01,currency:'USD'})),observedAtMs:now(),
 balance:{usd:1.5,observedAtMs:now(),source:'fal-account-billing-api'},balanceError:null,
 connectionId:'reviewed_connection',expiresAtMs,autoTopUpVerified:false,generationInvoked:false};

test('approved native files advance the prepared runtime once without browser tokens',async()=>{
 const calls=[],timers=[];let activation=false,operational=false,closed=false,saved;
 const runtime={
  status(){return {connected:true};},
  async attachOwner(){calls.push('attachOwner');return {connected:true};},
  async prepareRegistration(){calls.push('prepare');return registration;},
  async activateNative(){calls.push('activate');},
  async readProviderMetadata(){calls.push('metadata');return metadata;},
  async prepareNativeBootstrap(){calls.push('bootstrap');},
  async configureNativeTrial(){calls.push('trial');},
  async close(){closed=true;},
 };
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now,
  readActivation:async()=>{if(!activation)throw Error('PENDING');return {approved:true,keychainApproval:{}};},
  readOperationalConfiguration:async()=>{if(!operational)throw Error('PENDING');return {};},
  readCurrent:()=>({audioAssetId:'a',referenceAssetId:'r',playback:{phase:'IDLE',revision:0,actual:false}}),
  writeMetadata:async value=>{saved=value;},schedule:fn=>{timers.push(fn);return {unref(){}};},
  cancel:()=>{},pollMs:100});
 await wrapper.attachOwner({ownerCapability:'fixture-only'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['attachOwner','prepare']);
 assert.equal(timers.length,1);
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['attachOwner','prepare']);
 activation=true;
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['attachOwner','prepare','activate','metadata','bootstrap']);
 assert.equal(saved.balance.usd,1.5);
 assert.equal(saved.generationInvoked,false);
 operational=true;
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['attachOwner','prepare','activate','metadata','bootstrap','trial']);
 assert.deepEqual(wrapper.status().nativeOrchestration,{state:'ready',stage:'complete'});
 await wrapper.close();assert.equal(closed,true);
});

test('missing authenticated balance preserves prices and holds before trial without retry',async()=>{
 const calls=[],timers=[];let saved;
 const runtime={status:()=>({}),attachOwner:async()=>({}),prepareRegistration:async()=>registration,
  activateNative:async()=>{calls.push('activate');},
  readProviderMetadata:async()=>{calls.push('metadata');return {...metadata,balance:null,balanceError:'FAL_BALANCE_HOLD'};},
  prepareNativeBootstrap:async()=>{calls.push('bootstrap');},
  configureNativeTrial:async()=>{calls.push('trial');},close:async()=>{}};
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now,
  readActivation:async()=>({approved:true,keychainApproval:{}}),readOperationalConfiguration:async()=>({}),
  readCurrent:()=>({audioAssetId:'a',referenceAssetId:'r',playback:{phase:'IDLE',revision:0}}),
  writeMetadata:async value=>{saved=value;},schedule:fn=>{timers.push(fn);return {unref(){}};},
  cancel:()=>{},pollMs:100});
 await wrapper.attachOwner({});await new Promise(resolve=>setImmediate(resolve));
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(saved.prices.length,3);assert.equal(saved.balance,null);
 assert.equal(saved.balanceError,'FAL_BALANCE_HOLD');
 assert.deepEqual(calls,['activate','metadata']);
 assert.deepEqual(wrapper.status().nativeOrchestration,{state:'hold',stage:'provider-metadata'});
 assert.equal(timers.length,0);
 await wrapper.close();
});

test('closing aborts the runtime before waiting for pending preparation',async()=>{
 let finish,closed=false;
 const runtime={status:()=>({}),attachOwner:async()=>({}),activateNative:async()=>{},
  prepareRegistration:()=>new Promise(resolve=>{finish=resolve;}),close:async()=>{closed=true;finish(registration);}};
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now,
  readActivation:async()=>{},readOperationalConfiguration:async()=>{},readCurrent:()=>null,
  writeMetadata:async()=>{},schedule:()=>({unref(){}}),cancel:()=>{}});
 await wrapper.attachOwner({});await new Promise(resolve=>setImmediate(resolve));
 await wrapper.close();assert.equal(closed,true);
});

test('provider metadata writer emits only fixed nonsecret fields in a 0600 file',async t=>{
 const dir=await mkdtemp('/tmp/ai-vdj-metadata-test-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const writer=createPrivateMetadataWriter({activationFile:path.join(dir,'activation.json')});
 const safe=publicProviderMetadata({...metadata,unexpectedSecret:'must-not-appear'},
  {roomId,registration,expiresAtMs,now});
 await writer(safe);
 const file=path.join(dir,'activation.provider-metadata.json');
 assert.equal((await stat(file)).mode&0o777,0o600);
 const content=await readFile(file,'utf8');assert(!content.includes('must-not-appear'));
 await assert.rejects(writer(safe),/EDGE_TRIAL_NATIVE_HOLD/);
 assert.equal(JSON.parse(content).prices.length,3);
});

test('expiry during native activation prevents metadata, bootstrap and trial stages',async()=>{
 let clock=1_000_000,finishActivation;const timers=[],calls=[];
 const runtime={status:()=>({}),attachOwner:async()=>({}),prepareRegistration:async()=>registration,
  activateNative:()=>new Promise(resolve=>{finishActivation=resolve;}),
  readProviderMetadata:async()=>{calls.push('metadata');},prepareNativeBootstrap:async()=>{calls.push('bootstrap');},
  configureNativeTrial:async()=>{calls.push('trial');},close:async()=>{}};
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now:()=>clock,
  readActivation:async()=>({approved:true,keychainApproval:{}}),readOperationalConfiguration:async()=>({}),
  readCurrent:()=>({audioAssetId:'a',referenceAssetId:'r',playback:{phase:'IDLE',revision:0}}),writeMetadata:async()=>{},
  schedule:fn=>{timers.push(fn);return {unref(){}};},cancel:()=>{}});
 await wrapper.attachOwner({});await new Promise(resolve=>setImmediate(resolve));
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 clock=expiresAtMs;finishActivation();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[]);assert.equal(timers.length,0);
 assert.equal(wrapper.status().nativeOrchestration.state,'expired');await wrapper.close();
});

test('closing before a queued approval poll prevents activation and following stages',async()=>{
 const timers=[],calls=[];
 const runtime={status:()=>({}),attachOwner:async()=>({}),prepareRegistration:async()=>registration,
  activateNative:async()=>{calls.push('activate');},close:async()=>{calls.push('close');}};
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now,
  readActivation:async()=>({approved:true}),readOperationalConfiguration:async()=>({}),readCurrent:()=>null,
  writeMetadata:async()=>{},schedule:fn=>{timers.push(fn);return {unref(){}};},cancel:()=>{}});
 await wrapper.attachOwner({});await new Promise(resolve=>setImmediate(resolve));await wrapper.close();
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['close']);assert.equal(wrapper.status().nativeOrchestration.state,'closed');
});

test('an empty room can configure its reviewed operator before local bootstrap exists',async()=>{
 const timers=[],calls=[];let operational=false,source=null;
 const runtime={status:()=>({generationEnabled:false}),attachOwner:async()=>({}),prepareRegistration:async()=>registration,
  activateNative:async()=>{calls.push('activate');},readProviderMetadata:async()=>metadata,
  prepareNativeBootstrap:async()=>{calls.push('bootstrap');},configureNativeTrial:async()=>{calls.push('trial');},close:async()=>{}};
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now,
  readActivation:async()=>({approved:true,keychainApproval:{}}),readOperationalConfiguration:async()=>{
   if(!operational)throw Error('PENDING');return {};},readCurrent:()=>source,
  writeMetadata:async()=>{},schedule:fn=>{timers.push(fn);return {unref(){}};},cancel:()=>{}});
 await wrapper.attachOwner({});await new Promise(resolve=>setImmediate(resolve));
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['activate']);
 assert.equal(wrapper.status().nativeOrchestration.stage,'operational-approval');
 operational=true;timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['activate','trial']);
 assert.equal(wrapper.status().generationEnabled,false);
 assert.deepEqual(wrapper.status().nativeOrchestration,{state:'ready',stage:'complete'});
 assert.equal(timers.length,1);
 source={audioAssetId:'a',referenceAssetId:'r',playback:{phase:'IDLE',revision:0,actual:false}};
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['activate','trial','bootstrap']);
 assert.equal(timers.length,0);await wrapper.close();
});

test('operator configuration remains unavailable without native Keychain approval',async()=>{
 const timers=[],calls=[];
 const runtime={status:()=>({generationEnabled:false}),attachOwner:async()=>({}),prepareRegistration:async()=>registration,
  activateNative:async()=>{},readProviderMetadata:async()=>{calls.push('metadata');return metadata;},
  prepareNativeBootstrap:async()=>{calls.push('bootstrap');},configureNativeTrial:async()=>{calls.push('trial');},close:async()=>{}};
 const wrapper=createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,now,
  readActivation:async()=>({approved:true}),readOperationalConfiguration:async()=>{calls.push('operational');return {};},
  readCurrent:()=>null,writeMetadata:async()=>{},schedule:fn=>{timers.push(fn);return {unref(){}};},cancel:()=>{}});
 await wrapper.attachOwner({});await new Promise(resolve=>setImmediate(resolve));
 timers.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[]);assert.equal(wrapper.status().generationEnabled,false);await wrapper.close();
});
