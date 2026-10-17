import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createJudgeRoomFactory} from '../cloud/server/room-runtime.mjs';
import {createJudgeStore} from '../cloud/server/judge-store.mjs';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
import {createSupabaseStorageTransport} from '../cloud/worker/supabase-storage-transport.mjs';
import {syntheticWave,syntheticReference,fixtureSha} from './cloud-worker-fixture.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
const run=promisify(execFile),origin='https://ai-vdj.vercel.app',projectURL='https://example.supabase.co';
test('cloud server restores a private template and performs real CPU preparation without a Mac or paid generation',
 {skip:!process.env.VDJ_QC_PYTHON,timeout:120000},async t=>{
 const db=new PGlite(),objects=new Map();let factory,host,tail=Promise.resolve(),providerPosts=0;
 const directory=await mkdtemp(join(tmpdir(),'vdj-judge-test-'));
 t.after(async()=>{await host?.close();factory?.close();await db.close();await rm(directory,{recursive:true,force:true});});
 const locked=async fn=>{const previous=tail;let unlock;tail=new Promise(r=>{unlock=r;});await previous;try{return await fn();}finally{unlock();}};
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql',
  'cloud/jobs/player-observer-state.sql','cloud/jobs/durable-scheduler.sql','cloud/jobs/operator-state.sql','cloud/server/judge-state.sql'])
  await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 await db.exec("insert into vdj_internal.judge_events values('judge-native',true,now()+interval '1 hour',2,500)");
 const store=createJudgeStore({query:(...args)=>locked(()=>db.query(...args)),eventId:'judge-native'});
 const ownerToken='a'.repeat(64),room=await store.create({nonce:'11111111-1111-4111-a111-111111111111',ownerToken,joinCode:'b'.repeat(64)});
 const fetchImpl=async(url,options)=>{
  const parsed=new URL(url),path=parsed.pathname;
  if(parsed.origin==='https://api.fal.ai'){
   assert.equal(options.method,'GET');
   return Response.json({prices:['intent','music','video'].map(k=>GENERATION_CONTRACT[k]).map(endpoint_id=>({endpoint_id,currency:'USD',unit:'unit',unit_price:.1})),has_more:false,next_cursor:null});
  }
  assert.equal(parsed.origin,projectURL);if(options.method==='POST'&&path.includes('queue'))providerPosts++;
  if(path.startsWith('/rest/v1/rpc/')){
   const b=JSON.parse(options.body),roomRead=path.endsWith('/vdj_room_request');
   try{const result=await locked(()=>db.query(roomRead?'select public.vdj_room_request($1,$2,$3,$4::jsonb) value':'select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
    [b.op,b.room_id,b.capability,JSON.stringify(b.payload)]));return Response.json(result.rows[0].value);}
   catch(e){return Response.json({message:e.message},{status:400});}
  }
  if(path==='/storage/v1/bucket/ai-vdj-private')return Response.json({id:'ai-vdj-private',public:false,file_size_limit:33554432,allowed_mime_types:['audio/wav','video/mp4','image/png','image/jpeg','application/json']});
  const get='/storage/v1/object/authenticated/ai-vdj-private/',put='/storage/v1/object/ai-vdj-private/';
  if(options.method==='GET'&&path.startsWith(get)){const object=objects.get(decodeURIComponent(path.slice(get.length)));
   return object?new Response(object.bytes.slice(),{headers:{'content-type':object.type,'content-length':String(object.bytes.length)}}):Response.json({code:'NoSuchKey'},{status:404});}
  if(options.method==='POST'&&path.startsWith(put)){const key=decodeURIComponent(path.slice(put.length));
   if(objects.has(key))return Response.json({code:'KeyAlreadyExists'},{status:409});
   objects.set(key,{bytes:Uint8Array.from(options.body),type:options.headers.get('content-type')});return Response.json({Key:'ai-vdj-private/'+key});}
  assert.fail('Unexpected synthetic route');
 };
 const headers=new Headers();
 for(const name of ['authorization','apikey'])headers.set(name,'synthetic-authorization');
 const sourceRoom='22222222-2222-4222-a222-222222222222';
 const transport=createSupabaseStorageTransport({enabled:true,roomId:sourceRoom,projectUrl:projectURL,fetchImpl,readAuthHeaders:async()=>headers});
 const assets=createSupabasePrivateStore({enabled:true,roomId:sourceRoom,transport});
 await run(process.env.VDJ_QC_FFMPEG??'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=4:duration=20','-an','-c:v','libx264','-pix_fmt','yuv420p','-y',join(directory,'synthetic.mp4')]);
 const source={roomId:sourceRoom};
 for(const [name,bytes,type] of [['audio',syntheticWave(24),'audio/wav'],['reference',syntheticReference(),'image/png'],['video',await readFile(join(directory,'synthetic.mp4')),'video/mp4']]){
  const assetId='synthetic-'+name;await assets.assetStore.save({id:assetId,bytes,contentType:type,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap',actualGenerationThisRun:false}});
  source[name]={assetId,sha256:fixtureSha(bytes)};
 }
 assets.close();transport.close();
 const createPool=async policy=>({options:policy,on(){},async end(){},async connect(){
  const previous=tail;let unlock;tail=new Promise(r=>{unlock=r;});await previous;
  return {release(){unlock();},query:({text,values})=>db.query(text,values)};
 }});
 factory=createJudgeRoomFactory({configuration:{origin,projectURL,source,expiresAtMs:Date.now()+3600000,
  infrastructureMaximumUsd:1,autoTopUp:false,billingObservedAtMs:Date.now(),billingEvidenceSha256:'c'.repeat(64),bounds:{}},
  createPool,withPlatformHeaders:async(_scope,invoke)=>invoke(headers),readCredential:async()=>'synthetic-provider-key',fetchImpl,
  runtime:{python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'}});
 host=await factory.create({roomId:room.roomId,ownerCapability:ownerToken,reserveBudget:async()=>{}});
 const response=await host.handleRequest(new Request(origin+'/api/rooms/'+room.roomId+'/operator/status',{headers:{origin,'x-room-owner':ownerToken}}));
 const status=await response.json();assert.equal(response.status,200);assert.equal(status.serverManaged,true);
 assert.equal(status.macRequired,false);assert.equal(status.connection.verified,true);
 assert.deepEqual(status.assets.map(a=>a.role).sort(),['reference','saved-video','seed']);assert.ok(status.participants.includes(1));
 assert.equal(providerPosts,0);
});
