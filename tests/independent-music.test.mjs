import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createD1JudgeStore} from '../cloud/cloudflare/d1-store.mjs';
import {createGenerationClass} from '../cloud/cloudflare/generation-runtime.mjs';
import {createGenerationStore} from '../cloud/cloudflare/generation-store.mjs';
import {createSoundtrackClass} from '../cloud/cloudflare/soundtrack-runtime.mjs';
import {createAudienceRoomClass} from '../cloud/cloudflare/audience-room.mjs';
import {soundtrackHttp} from '../cloud/cloudflare/soundtrack-http.mjs';
import {generationHttp} from '../cloud/cloudflare/generation-http.mjs';
import {MODELS,sha256} from '../cloud/cloudflare/fal-provider.mjs';
import {eligibleSets,playbackState} from '../cloud/cloudflare/playback-queue.mjs';
import {createSoundtrackPlayer,musicWindow} from '../room-web/judge-soundtrack.mjs';
import {createSetPlayer} from '../room-web/judge-set-player.mjs';

function audioContext(){
  let now=0;const starts=[],curves=[],sources=[];
  const param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},setValueCurveAtTime(v,at,duration){curves.push({v,at,duration});}});
  const node=()=>({connect(){},disconnect(){}});
  return {starts,curves,sources,get currentTime(){return now;},set currentTime(v){now=v;},state:'running',async resume(){},
    createBufferSource(){const source={...node(),start(at,offset,duration){starts.push({at,offset,duration});},stop(){}};sources.push(source);return source;},
    createGain:()=>({...node(),gain:param()}),createBiquadFilter:()=>({...node(),frequency:param(),gain:param()})};
}
test('mix window excludes a generated multi-second fade instead of amplifying silence',()=>{
  const samples=new Float32Array(60000).fill(.3);
  for(let i=56000;i<60000;i++)samples[i]=.3*(60000-i)/4000;
  for(let i=0;i<1000;i++)samples[i]=.3*i/1000;
  const window=musicWindow({duration:60,sampleRate:1000,getChannelData:()=>samples});
  assert.ok(window.offset>.3 && window.offset<1);
  assert.ok(window.end>57 && window.end<59);
  assert.ok(window.duration>55);
});
test('sixty-second music overlaps, survives twelve-second visual changes and retains a decoded fallback',async()=>{
  const context=audioContext(),heard=[];
  const player=createSoundtrackPlayer({context,onTrack:t=>heard.push(t.id),setTimer(){},clearTimer(){}});
  player.add({id:'one',buffer:{duration:60}});player.add({id:'two',buffer:{duration:60}});
  player.start();context.currentTime=.2;player.tick();
  for(const now of [12,24,36,48]){context.currentTime=now;player.tick();}
  assert.equal(context.starts.length,1);
  context.currentTime=53;player.tick();
  assert.equal(context.starts.length,2);
  assert.ok(context.starts[1].at<context.starts[0].at+60);
  assert.ok(context.starts.every(s=>s.duration===60));
  assert.ok(context.curves.every(c=>c.duration>3));
  context.currentTime=57;player.tick();assert.deepEqual(heard,['one','two']);
  context.currentTime=110;player.tick();assert.equal(context.starts.length,3);
  player.stop();context.currentTime=170;player.tick();assert.equal(context.starts.length,3);
});
test('the visual clock changes every twelve seconds without creating audio sources',async()=>{
  const context=audioContext(),changes=[];
  const set={id:'visual',assets:{video:{duration:12}}};
  const player=createSetPlayer({context,audioEnabled:false,choose:async()=>set,fallback:()=>set,
    onStart:s=>changes.push(s.id),setTimer(){},clearTimer(){}});
  await player.start();context.currentTime=.1;player.tick();context.currentTime=10.2;player.tick();
  await Promise.resolve();await Promise.resolve();context.currentTime=12.1;player.tick();
  assert.equal(context.starts.length,0);assert.equal(changes.length,2);
  assert.ok(player.read().scheduled.every(s=>Math.abs(s.end-s.start-12)<1e-6));player.stop();
});
test('stopping and restarting retains the last decoded sixty-second song',()=>{
  const context=audioContext();
  const player=createSoundtrackPlayer({context,setTimer(){},clearTimer(){}});
  player.setFallback({id:'preset',buffer:{duration:12}});
  player.add({id:'music',buffer:{duration:60}});
  player.start();player.stop();player.start();
  assert.equal(context.starts.at(-1).duration,60);
  player.stop();
});

async function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile(new URL('../cloud/cloudflare/schema.sql',import.meta.url),'utf8'));
  sqlite.prepare('insert into vdj_events values(?,1,?,100,37500)').run('judge-test',Date.now()+3600000);
  const db={prepare:sql=>({bind(...args){const q=sqlite.prepare(sql);return {async first(){return q.get(...args)??null;},async all(){return {results:q.all(...args)};},async run(){return {meta:{changes:Number(q.run(...args).changes)}};}};}})};
  db.batch=async statements=>{sqlite.exec('begin');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('commit');return results;}catch(e){sqlite.exec('rollback');throw e;}};
  const storage=()=>{const map=new Map();return {async get(k){return structuredClone(map.get(k));},async put(k,v){map.set(k,structuredClone(v));},async setAlarm(v){map.set('alarm',v);},async getAlarm(){return map.get('alarm');},async deleteAlarm(){map.delete('alarm');},async delete(k){map.delete(k);},map};};
  const owner='a'.repeat(64),store=createGenerationStore({db,eventId:'judge-test',normalized:true,independentAudio:true});
  const room=await createD1JudgeStore({db,eventId:'judge-test'}).create({nonce:crypto.randomUUID(),ownerToken:owner,joinCode:'b'.repeat(64)});
  const posts=[],objects=new Map();let uncertain=false;
  const env={DB:db,EVENT_ID:'judge-test',PUBLIC_ORIGIN:'https://test.example',AUDIENCE_MODE:'true',INDEPENDENT_AUDIO:'true',GENERATION_ENABLED:'true',FAL_KEY:'synthetic-test-value',
    MEDIA:{async head(k){return objects.get(k);},async put(k,bytes,options){objects.set(k,{bytes,size:bytes.length,etag:'synthetic',...options});},async get(k){const v=objects.get(k);return v?{...v,body:new Blob([v.bytes]).stream()}:null;}},
    testFetch:async(url,options)=>{
      if(String(url).includes('pricing'))return Response.json({prices:Object.values(MODELS).map(endpoint_id=>({endpoint_id,currency:'USD',unit:endpoint_id.includes('audio')?'audios':'seconds',unit_price:.04}))});
      if(options?.method==='POST'){posts.push({url:String(url),input:JSON.parse(options.body)});if(uncertain)throw Error('connection lost');const id=crypto.randomUUID();return Response.json({request_id:id,status_url:`https://queue.fal.run/a/requests/${id}/status`,response_url:`https://queue.fal.run/a/requests/${id}`});}
      if(String(url).endsWith('/status'))return Response.json({status:'COMPLETED'});
      if(String(url).includes('queue.fal.run'))return Response.json({audio:{url:'https://v3.fal.media/a'},video:{url:'https://v3.fal.media/v'}});
      return new Response(Uint8Array.of(1,2,3));
    },NATIVE_PROCESSOR:{getByName:()=>({async fetch(request){const a={data:'AQID',sha256:await sha256(Uint8Array.of(1,2,3))};return Response.json({audio:a,context:a,video:a,duration:Number(request.headers.get('x-vdj-duration-seconds')),width:1920,height:1080,quality:{passed:true}});}})}};
  const roomCtx={storage:storage(),waitUntil(){}};
  const coordinator=new (createAudienceRoomClass(class{}))(roomCtx,env);
  env.AUDIENCE_ROOMS={getByName:()=>coordinator};
  const ctx={storage:storage()},Class=createSoundtrackClass(class{});let runtime=new Class(ctx,env);
  env.GENERATION={getByName:()=>runtime};
  return {sqlite,db,store,room:room.roomId,owner,env,ctx,posts,coordinator,
    get runtime(){return runtime;},restart(){runtime=new Class(ctx,env);},uncertain(){uncertain=true;}};
}
test('music queues two sixty-second songs, outpaints the real tail and never spends again on repeated start',async()=>{
  const f=await fixture();try{
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();await f.runtime.soundtrack(f.room,{action:'start',clientId,runId});
    for(let i=0;i<5;i++)await f.runtime.alarm();
    assert.equal(f.posts.length,2,JSON.stringify((await f.store.records(f.room)).map(({state,reason})=>({state,reason}))));assert.equal(f.posts[0].input.duration,60);
    assert.equal(f.posts[1].input.extend_seconds_after,60);assert.match(f.posts[1].url,/outpainting/);
    assert.equal(f.sqlite.prepare('select sum(cents) n from vdj_budget_reservations').get().n,50);
    f.restart();await f.runtime.soundtrack(f.room,{action:'start',clientId,runId});await f.runtime.alarm();
    assert.equal(f.posts.length,2);
    const view=await f.runtime.soundtrack(f.room,{action:'view'});assert.equal(view.songs.length,2);
    await f.runtime.soundtrack(f.room,{action:'played',clientId,runId,id:view.songs[0].id});await f.runtime.alarm();
    assert.equal(f.posts.length,3);
    const publicView=await generationHttp(new Request(`https://test.example/api/rooms/${f.room}/generation`,{headers:{'x-room-owner':f.owner}}),f.env);
    assert.deepEqual((await publicView.json()).jobs,[]);
  }finally{f.sqlite.close();}
});
test('a lost paid music receipt is held across restart and a stop cannot submit the queued continuation',async()=>{
  const f=await fixture();try{
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();f.uncertain();await f.runtime.soundtrack(f.room,{action:'start',clientId,runId});
    await f.runtime.alarm();f.restart();await f.runtime.alarm();assert.equal(f.posts.length,1);
    assert.equal((await f.runtime.soundtrack(f.room,{action:'view'})).songs[0].state,'NEEDS_REVIEW');
  }finally{f.sqlite.close();}
  const g=await fixture();try{
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();await g.runtime.soundtrack(g.room,{action:'start',clientId,runId});
    await g.runtime.alarm();await g.runtime.alarm();assert.equal(g.posts.length,1);
    await g.runtime.soundtrack(g.room,{action:'stop',clientId,runId});await g.runtime.alarm();assert.equal(g.posts.length,1);
  }finally{g.sqlite.close();}
});
test('a reloaded owner can reuse a ready song when all songs were already played',async()=>{
  const f=await fixture();try{
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();
    await f.runtime.soundtrack(f.room,{action:'start',clientId,runId});
    for(let i=0;i<5;i++)await f.runtime.alarm();
    const {songs}=await f.runtime.soundtrack(f.room,{action:'view'});
    for(const song of songs)await f.runtime.soundtrack(f.room,{action:'played',clientId,runId,id:song.id});
    await f.runtime.soundtrack(f.room,{action:'stop',clientId,runId});
    const posts=f.posts.length;
    const reloaded=await f.runtime.soundtrack(f.room,{action:'view'});
    assert.equal(reloaded.songs.at(-1)?.id,songs.at(-1).id);
    assert.equal(reloaded.songs.at(-1)?.state,'READY');
    assert.equal(f.posts.length,posts);
  }finally{f.sqlite.close();}
});
test('the owner lease prevents a second tab or participant from starting another paid stream',async()=>{
  const f=await fixture();try{
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();await f.coordinator.playback(f.room,{action:'heartbeat',clientId});
    const request=(body,headers={})=>new Request(`https://test.example/api/rooms/${f.room}/soundtrack`,{method:'POST',headers:{origin:'https://test.example','content-type':'application/json','x-room-owner':f.owner,...headers},body:JSON.stringify(body)});
    assert.equal((await soundtrackHttp(request({action:'start',clientId,runId}),f.env)).status,200);
    assert.equal((await soundtrackHttp(request({action:'start',clientId:crypto.randomUUID(),runId}),f.env)).status,409);
    const participantRequest=request({action:'start',clientId,runId});
    participantRequest.headers.set('authorization',['Bearer','b'.repeat(64)].join(' '));
    assert.equal((await soundtrackHttp(participantRequest,f.env)).status,403);
    assert.equal(f.posts.length,0);
  }finally{f.sqlite.close();}
});
test('new submissions generate only a visual and remain eligible without an audio asset',async()=>{
  const f=await fixture();try{
    const submitted=await f.coordinator.roomOperation({op:'submit',room_id:f.room,capability:f.owner,payload:{nonce:crypto.randomUUID(),nickname:'合成',prompt:'回転するネオン'}});
    const runtime=new (createGenerationClass(class{}))({storage:{...f.ctx.storage}},f.env);
    await runtime.enqueue(f.room,[submitted.submissionId]);await runtime.alarm();await runtime.alarm();
    assert.equal(f.posts.length,1);assert.equal(f.posts[0].input.duration,12);assert.match(f.posts[0].url,/text-to-video/);
    const job=(await f.store.records(f.room))[0];assert.equal(job.state,'READY');assert.equal(job.assets.audio,undefined);
    assert.equal(eligibleSets([job],playbackState()).length,1);assert.equal(job.profile,'visual-12-v1');
    const playback=await f.coordinator.playback(f.room,{action:'view'});
    assert.deepEqual(playback.queue.map(j=>j.id),[job.id]);
  }finally{f.sqlite.close();}
});
test('late heartbeats and start requests cannot revive a stopped music run',async()=>{
  const f=await fixture();try{
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();
    await f.runtime.soundtrack(f.room,{action:'stop',clientId,runId});
    await assert.rejects(f.runtime.soundtrack(f.room,{action:'start',clientId,runId}),/PLAYBACK_INPUT_INVALID/);
    await assert.rejects(f.runtime.soundtrack(f.room,{action:'pulse',clientId,runId}),/PLAYBACK_INPUT_INVALID/);
    await f.runtime.alarm();assert.equal(f.posts.length,0);
    assert.equal(f.sqlite.prepare('select count(*) n from vdj_budget_reservations').get().n,0);
  }finally{f.sqlite.close();}
});
test('resuming a waiting video restarts polling without repeating the paid request',async()=>{
  const f=await fixture();try{
    const submitted=await f.coordinator.roomOperation({op:'submit',room_id:f.room,capability:f.owner,payload:{nonce:crypto.randomUUID(),nickname:'合成',prompt:'回転する光'}});
    const ctx={storage:{...f.ctx.storage}};
    const runtime=new (createGenerationClass(class{}))(ctx,f.env);
    await runtime.enqueue(f.room,[submitted.submissionId]);await runtime.alarm();
    assert.equal(f.posts.length,1);
    await ctx.storage.deleteAlarm();
    assert.equal((await runtime.retryPreparation(f.room,[submitted.submissionId])).resumed,1);
    assert.ok(await ctx.storage.getAlarm());
    await runtime.alarm();
    assert.equal((await f.store.records(f.room))[0].state,'READY');
    assert.equal(f.posts.length,1);
  }finally{f.sqlite.close();}
});
test('approved shared club tracks replace old background music without buying new tracks',async()=>{
  const f=await fixture();try{
    const id=crypto.randomUUID(),bytes=Uint8Array.of(1,2,3),path='curated/test/audio';
    f.sqlite.prepare("insert into vdj_runtime_records values(?,'curated-soundtrack',?,0,?)").run(f.room,id,JSON.stringify({id,state:'READY',assets:{audio:{duration:60,sha256:await sha256(bytes),byteLength:3,contentType:'audio/wav',path}}}));
    await f.env.MEDIA.put(path,bytes,{});
    const media=await generationHttp(new Request(`https://test.example/api/rooms/${f.room}/generated-media/${id}/audio`,{headers:{'x-room-owner':f.owner}}),f.env);
    assert.equal(media.status,200);assert.equal((await media.arrayBuffer()).byteLength,3);
    const denied=await generationHttp(new Request(`https://test.example/api/rooms/${f.room}/generated-media/${id}/audio`),f.env);
    assert.equal(denied.status,403);
    const clientId=crypto.randomUUID(),runId=crypto.randomUUID();
    const initial=await f.runtime.soundtrack(f.room,{action:'start',clientId,runId});
    assert.equal(initial.songs[0].id,id);
    await f.runtime.alarm();assert.equal(f.posts.length,0);
    const after=await f.runtime.soundtrack(f.room,{action:'played',clientId,runId,id});
    assert.equal(after.songs[0].id,id);
    assert.equal((await f.runtime.soundtrack(f.room,{action:'view'})).songs[0].id,id);
    assert.equal(f.sqlite.prepare('select count(*) n from vdj_budget_reservations').get().n,0);
  }finally{f.sqlite.close();}
});
