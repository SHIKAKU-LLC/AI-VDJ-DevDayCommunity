import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createGenerationDispatcher, GENERATION_CONTRACT, validatePermit} from '../cloud/generation/dispatch.mjs';
import {createGenerationHandler} from '../cloud/generation/http.mjs';
import {createGenerationProvider} from '../cloud/generation/provider.mjs';
import {createEdgeGenerationHandler} from '../cloud/generation/edge-runtime.mjs';
import {createSessionGeneration} from '../room-web/tab-generation.mjs';
import {createFalClient} from '../snapshot/node_modules/@fal-ai/client/src/index.js';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

const owner='a'.repeat(64), guest='b'.repeat(64), invitation='c'.repeat(64);
const credential='synthetic-session-credential';
const opId='operation_'+'x'.repeat(24), permitId='permit_'+ 'p'.repeat(24);
const source={music:{clipId:'synthetic-parent',contextSeconds:16,contextSha256:'d'.repeat(64),contextVerified:true,
  ready:true,control:{version:1,energy:.5,tension:.5,density:.5,brightness:.5}},
  video:{motifId:'synthetic-motif',motifSnapshotSha256:'e'.repeat(64),referenceSha256:'f'.repeat(64)},
  quality:{fixedBpm:145,tempoConfidence:'assumed'}};
const semantic={needsClarification:false,question:'',interpretation:'穏やかに広がる',direction:'down',intensity:.5,
  visualOpenness:'increase',musicDevelopment:'Reduce competing layers gently.',visualDevelopment:'Open the geometry and preserve detail.'};
const baseSql=await readFile(new URL('../cloud/room/schema.sql',import.meta.url),'utf8');
const generationSql=await readFile(new URL('../cloud/generation/schema.sql',import.meta.url),'utf8');
async function setup(providerOverride={}) {
  const db=new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(baseSql); await db.exec(generationSql);
  const uid='11111111-1111-4111-a111-111111111111';
  await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
  const roomCall=async(op,capability,payload={},verified_uid=null)=>(await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) result',
    [op,room?.roomId??null,capability,JSON.stringify(payload),verified_uid])).rows[0].result;
  let room=null;
  room=await roomCall('create',null,{ownerCapability:owner,joinCode:invitation},uid);
  await roomCall('join',invitation,{nickname:'synthetic guest',participantCapability:guest});
  const submission=await roomCall('submit',guest,{nonce:'submission_'+ 's'.repeat(24),prompt:'静かな星空'});
  const time=Date.now();
  const permit={permitId,kind:GENERATION_CONTRACT.version,counts:GENERATION_CONTRACT.counts,
    createdAtMs:time,expiresAtMs:time+600000,maximumUsd:1,source,sourceSha256:cueDigest(cueSourceIdentity(source)),
    quote:{verified:true,evidenceSha256:'1'.repeat(64),observedAtMs:time,maximumUsd:{intent:.01,music:.1,video:.5}},
    balance:{usd:2,autoTopUp:false,observedAtMs:time},
    assets:{context:{url:'https://synthetic.supabase.co/storage/v1/object/sign/private/context',private:true,
      checksumVerified:true,sha256:source.music.contextSha256,expiresAtMs:time+660000,serverAudioQC:true,providerOriginVerified:true},
    reference:{url:'https://synthetic.supabase.co/storage/v1/object/sign/private/reference',private:true,
      checksumVerified:true,sha256:source.video.referenceSha256,expiresAtMs:time+660000}}};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
    select $1,id,epoch,control_revision,to_timestamp($3),$4::jsonb from vdj_internal.rooms where id=$2`,
    [permitId,room.roomId,permit.expiresAtMs/1000,JSON.stringify(permit)]);
  const repository={request:async(op,roomId,capability,payload)=>(await db.query(
    'select public.vdj_generation_request($1,$2,$3,$4::jsonb) result',[op,roomId,capability,JSON.stringify(payload)])).rows[0].result};
  const sent=[], read=[];
  const provider={submit:async input=>{sent.push(input);return{request_id:'request_'+sent.length};},
    status:async input=>({status:'COMPLETED'}),result:async input=>{
      read.push(input);return {data:input.model===GENERATION_CONTRACT.intent?{output:JSON.stringify(semantic),usage:{cost:.001}}:
        input.model===GENERATION_CONTRACT.music?{audio:{url:'https://v3.fal.media/files/synthetic.wav'}}:
        {video:{url:'https://v3.fal.media/files/synthetic.mp4'}}};},...providerOverride};
  const dispatcher=createGenerationDispatcher({enabled:true,repository,provider,mediaHost:'synthetic.supabase.co'});
  const execute=(action,body={},extra={})=>dispatcher.execute({action,roomId:room.roomId,ownerCapability:owner,
    key:credential,body:{operationId:opId,...body},...extra});
  const begin=()=>execute('begin',{permitId,submissionId:submission.submissionId});
  return {db,room,roomCall,repository,provider,dispatcher,execute,begin,sent,read,permit,submission};
}

test('real SQL stage ledger allows one intent and concurrent AV, never certifies QC or playback',async()=>{
  const x=await setup();try{
    await x.begin();await x.execute('submit',{stage:'intent'});await x.execute('poll',{stage:'intent'});
    await Promise.all(['music','video'].map(stage=>x.execute('submit',{stage})));
    await Promise.all(['music','video'].map(stage=>x.execute('poll',{stage})));
    const result=await x.execute('read');assert.equal(result.state,'WAIT_QC');assert.equal(result.cueReady,false);
    const descriptor=await x.execute('descriptor');assert.equal(descriptor.operationId,opId);
    assert.equal('keyProof' in descriptor,false);assert.equal('quote' in descriptor.permit,false);
    assert.equal(result.actualPlayback,false);assert.equal(x.sent.length,3);
    await x.execute('submit',{stage:'music'});await x.execute('poll',{stage:'video'});assert.equal(x.sent.length,3);
    assert.equal(x.sent[1].input.extend_seconds_after,24);assert.equal(x.sent[2].input.duration,5);
    for(const input of x.sent) assert.ok(!JSON.stringify(input.input).includes(credential));
    const stored=await x.db.query('select document::text from vdj_internal.generation_operations');
    assert.ok(!stored.rows[0].document.includes(credential));assert.ok(!JSON.stringify(result).includes(credential));
    assert.ok(!JSON.stringify(result).includes(x.permit.assets.context.url));
  }finally{await x.db.close();}
});
test('roles and room capabilities cannot grant a permit; participant cannot spend owner key',async()=>{
  const x=await setup();try{
    await assert.rejects(x.execute('begin',{permitId,submissionId:x.submission.submissionId},{ownerCapability:guest}),/OWNER_DENIED/);
    await x.db.exec('set role anon');
    await assert.rejects(x.db.query('select * from vdj_internal.generation_permits'),/permission denied/);
    await assert.rejects(x.db.query("select public.vdj_generation_request('read',null,null,'{}')"),/permission denied/);
    await x.db.exec('reset role');
    assert.equal(x.sent.length,0);
    const disabled=createGenerationDispatcher({repository:x.repository,provider:x.provider});
    await assert.rejects(disabled.execute({}),/GENERATION_NOT_ACTIVATED/);
  }finally{await x.db.close();}
});
test('permit binds source, confirmed price, fresh balance and finite one-use scope',async()=>{
  const x=await setup();try{
    assert.throws(()=>validatePermit({...x.permit,sourceSha256:'0'.repeat(64)},{mediaHost:'synthetic.supabase.co'}),/SOURCE_BINDING/);
    assert.throws(()=>validatePermit({...x.permit,balance:{...x.permit.balance,autoTopUp:true}},{mediaHost:'synthetic.supabase.co'}),/VERIFIED_PRICE/);
    await x.begin();
    await assert.rejects(x.execute('begin',{permitId,submissionId:x.submission.submissionId,operationId:'different_'+ 'y'.repeat(24)}),/PERMIT_ALREADY_USED/);
    await x.roomCall('control',owner,{nonce:'control_'+ 'r'.repeat(24),expectedRevision:0,accepting:false});
    await assert.rejects(x.execute('submit',{stage:'intent'}),/GENERATION_PERMIT_REQUIRED/);
    assert.equal(x.sent.length,0);
  }finally{await x.db.close();}
});
test('unknown submit is durable across a new dispatcher and never resent; wrong key is denied',async()=>{
  let calls=0;const x=await setup({submit:async()=>{calls++;throw Error('synthetic lost response');}});try{
    await x.begin();await assert.rejects(x.execute('submit',{stage:'intent'}),/UNKNOWN_NO_RETRY/);
    const fresh=createGenerationDispatcher({enabled:true,repository:x.repository,provider:x.provider,mediaHost:'synthetic.supabase.co'});
    await assert.rejects(fresh.execute({action:'submit',roomId:x.room.roomId,ownerCapability:owner,key:credential,
      body:{operationId:opId,stage:'intent'}}),/UNKNOWN_NO_RETRY/);
    await assert.rejects(x.execute('read',{}, {key:'different-synthetic-credential'}),/KEY_MISMATCH/);
    assert.equal((await x.execute('read')).state,'HOLD');assert.equal(calls,1);
  }finally{await x.db.close();}
});
test('overlapping requests share the durable claim and cannot send the same stage twice',async()=>{
  let release,started;const entered=new Promise(r=>{started=r;}),wait=new Promise(r=>{release=r;});let posts=0;
  const x=await setup({submit:async()=>{posts++;started();await wait;return{request_id:'one_actual_submission'};}});try{
    await x.begin();const first=x.execute('submit',{stage:'intent'});await entered;
    await assert.rejects(x.execute('submit',{stage:'intent'}),/UNKNOWN_NO_RETRY/);
    release();await first;await x.execute('submit',{stage:'intent'});assert.equal(posts,1);
  }finally{release();await x.db.close();}
});
test('bad or excessive-cost intent is held before AV; stop cannot create new stages',async()=>{
  const x=await setup({result:async()=>({data:{output:JSON.stringify(semantic),usage:{cost:10}}})});try{
    await x.begin();await x.execute('submit',{stage:'intent'});
    await assert.rejects(x.execute('poll',{stage:'intent'}),/RESULT_QC_HOLD/);
    await assert.rejects(x.execute('submit',{stage:'music'}),/COMPILED_INTENT_REQUIRED/);
    assert.equal(x.sent.length,1);assert.equal((await x.execute('read')).state,'HOLD');
    assert.equal((await x.execute('stop')).state,'STOPPED');
    await assert.rejects(x.execute('submit',{stage:'video'}),/GENERATION_STOPPED/);
  }finally{await x.db.close();}
});
test('HTTP rejects participant, cross-origin, budget overrides, oversized body and redacts internal errors',async()=>{
  let calls=0;const handler=createGenerationHandler({dispatcher:{execute:async()=>{calls++;throw Error(credential);}}});
  const url='https://ai-vdj.vercel.app/api/rooms/11111111-1111-4111-a111-111111111111/generation/begin';
  const request=(values,body='{}')=>{const headers=new Headers(values);headers.set('Content-Type','application/json');
    return handler(new Request(url,{method:'POST',headers,body}));};
  assert.equal((await request({Origin:'https://elsewhere.test'})).status,403);
  const guestHeaders=new Headers({Origin:'https://ai-vdj.vercel.app'});guestHeaders.set('Authorization','Bearer '+guest);
  assert.equal((await request(guestHeaders)).status,403);
  const h={Origin:'https://ai-vdj.vercel.app','X-Room-Owner':owner};
  assert.equal((await request(h,JSON.stringify({budget:100,confirmed:true}))).status,400);
  assert.equal((await request(h,' '.repeat(4097))).status,413);
  assert.deepEqual(await(await request(h)).json(),{error:'GENERATION_HOLD',automaticRetry:false});assert.equal(calls,1);
});
test('session client sends parallel AV only after intent, forgets on pagehide and does not resend unknown work',async()=>{
  const listeners=new Map(),calls=[];let active=0,peak=0;
  const client=createSessionGeneration({roomId:'11111111-1111-4111-a111-111111111111',ownerCapability:owner,
    credentials:credential,lifecycle:{addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)},
    delay:async()=>{},fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push({url,body});
      assert.equal(options.headers.get('X-Fal-Key'),credential);
      assert.ok(!options.body.includes(credential));
      let stages={};if(body.stage)stages[body.stage]={state:url.endsWith('/submit')?'SUBMITTED':'COMPLETE'};
      if(url.endsWith('/submit')&&body.stage!=='intent'){active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;}
      return new Response(JSON.stringify({state:'PENDING',stages}),{headers:{'Content-Type':'application/json'}});
    }});
  await client.run({operationId:opId,permitId,submissionId:'synthetic'});assert.equal(peak,2);
  assert.equal(calls.filter(x=>x.url.endsWith('/submit')).length,3);
  listeners.get('pagehide')();assert.equal(client.state().connected,false);
  await assert.rejects(client.read(opId),/SESSION_CLOSED/);
});
test('provider wrapper rejects SDK retry and redirects, with a fresh client for each operation',async()=>{
  let sends=0;
  const provider=createGenerationProvider({fetchImpl:async(url,init)=>{sends++;assert.equal(init.redirect,'error');return new Response('{}');},
    createFalClient:({fetch})=>({queue:{submit:async()=>{await fetch('https://queue.fal.run/fal-ai/example');return fetch('https://queue.fal.run/fal-ai/example');},
      status:async()=>fetch('https://not-fal.example/anything'),result:async()=>fetch('https://queue.fal.run/fal-ai/example')}})});
  await assert.rejects(provider.submit({key:credential,model:'x',input:{}}),/TRANSPORT_REFUSED/);assert.equal(sends,1);
  await assert.rejects(provider.status({key:credential,model:'x',requestId:'r'}),/TRANSPORT_REFUSED/);assert.equal(sends,1);
  await provider.result({key:credential,model:'x',requestId:'r'});assert.equal(sends,2);
});
test('actual pinned SDK uses request-only credentials with one external request per operation',async()=>{
  const calls=[];
  const provider=createGenerationProvider({createFalClient,fetchImpl:async(url,init)=>{
    calls.push({url,method:init.method});
    assert.equal(new Headers(init.headers).get('Authorization'),'Key '+credential);
    assert.equal(init.redirect,'error');
    return new Response(JSON.stringify({request_id:'synthetic_request',status:'COMPLETED',audio:{url:'https://v3.fal.media/synthetic.wav'}}),
      {headers:{'Content-Type':'application/json'}});
  }});
  const args={key:credential,model:GENERATION_CONTRACT.music,requestId:'synthetic_request'};
  await provider.submit({...args,input:{prompt:'synthetic'}});await provider.status(args);await provider.result(args);
  assert.equal(calls.length,3);assert.ok(calls.every(c=>new URL(c.url).hostname==='queue.fal.run'));
});
test('provider diagnostics distinguish fetch entry, response and receipt without logging keys, input or raw network errors',async()=>{
 const events=[],args={key:credential,model:GENERATION_CONTRACT.intent,input:{prompt:'private synthetic prompt'},operationId:opId,stage:'intent'};
 const provider=createGenerationProvider({createFalClient,onDiagnostic:e=>events.push(e),fetchImpl:async()=>
  Response.json({request_id:'synthetic_receipt'})});
 await provider.submit(args);
 assert.deepEqual(events.map(e=>e.event),['PROVIDER_HTTP_ATTEMPT','PROVIDER_HTTP_RESPONSE','PROVIDER_ACCEPTED']);
 assert(events.at(-1).reason.endsWith(':intent:synthetic_receipt'));
 assert(!JSON.stringify(events).includes(credential));assert(!JSON.stringify(events).includes(args.input.prompt));
 const failed=createGenerationProvider({createFalClient,onDiagnostic:e=>events.push(e),fetchImpl:async()=>{
  throw Object.assign(Error('private synthetic network detail'),{cause:{code:'ENOTFOUND'}});}});
 await assert.rejects(failed.submit(args));
 assert(events.some(e=>e.event==='PROVIDER_HTTP_REJECTED'&&e.reason.endsWith(':ENOTFOUND')));
 assert(!JSON.stringify(events).includes('private synthetic network detail'));
});
test('disabled Edge mount makes no database request and never loads provider SDK',async()=>{
  let touched=0;
  const handler=createEdgeGenerationHandler({projectURL:'https://synthetic.supabase.co',platformHeaders:new Headers(),
    fetchImpl:async()=>{touched++;throw Error('unexpected');},loadSDK:async()=>{touched++;throw Error('unexpected');}});
  const response=await handler(new Request('https://ai-vdj.vercel.app/api/rooms/11111111-1111-4111-a111-111111111111/generation/begin',
    {method:'POST',headers:{Origin:'https://ai-vdj.vercel.app','Content-Type':'application/json','X-Room-Owner':owner},body:'{}'}));
  assert.equal((await response.json()).error,'GENERATION_NOT_ACTIVATED');assert.equal(touched,0);
});
