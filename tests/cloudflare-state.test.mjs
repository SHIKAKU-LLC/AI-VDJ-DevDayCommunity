import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createD1JudgeStore} from '../cloud/cloudflare/d1-store.mjs';
import {createR2RoomTransport} from '../cloud/cloudflare/r2-transport.mjs';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
const nonce='11111111-1111-4111-a111-111111111111',other='22222222-2222-4222-a222-222222222222';
async function database(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile(new URL('../cloud/cloudflare/schema.sql',import.meta.url),'utf8'));
 sqlite.prepare('insert into vdj_events values(?,1,?,2,250)').run('judge-d1',Date.now()+3600000);
 const db={prepare:sql=>({bind(...values){const statement=sqlite.prepare(sql);return {
  async first(){return statement.get(...values)??null;},
  async run(){const r=statement.run(...values);return {success:true,meta:{changes:Number(r.changes)}};},
 };}})};
 return {sqlite,db,store:createD1JudgeStore({db,eventId:'judge-d1'})};
}
test('D1 schema preserves isolated room ownership, retry identity and durable global budget',async()=>{
 const {sqlite,db,store}=await database();try{
  const first=await store.create({nonce,ownerToken:a,joinCode:b});
  assert.deepEqual(await store.create({nonce,ownerToken:a,joinCode:b}),first);
  await assert.rejects(store.create({nonce,ownerToken:c,joinCode:b}),/JUDGE_DENIED/);
  const second=await store.create({nonce:other,ownerToken:b,joinCode:c});
  await assert.rejects(store.authorize(first.roomId,b),/JUDGE_DENIED/);
  await store.reserve({roomId:first.roomId,capability:a,planId:'plan-a',cents:250});
  const restarted=createD1JudgeStore({db,eventId:'judge-d1'});
  await restarted.reserve({roomId:first.roomId,capability:a,planId:'plan-a',cents:250});
  await assert.rejects(restarted.reserve({roomId:second.roomId,capability:b,planId:'plan-b',cents:50}),/JUDGE_BUDGET/);
  assert.equal(sqlite.prepare('select sum(cents) amount from vdj_budget_reservations').get().amount,250);
  sqlite.exec('update vdj_events set enabled=0');await assert.rejects(store.authorize(first.roomId,a),/JUDGE_CLOSED/);
 }finally{sqlite.close();}
});
test('D1 atomic room state rejects stale versions, secret fields and writes after expiry',async()=>{
 const {sqlite,store}=await database();try{
  const room=await store.create({nonce,ownerToken:a,joinCode:b});
  const update={roomId:room.roomId,capability:a,version:0,document:{accepted:1}};
  assert.deepEqual(await store.compareAndSwap(update),{version:1});
  await assert.rejects(store.compareAndSwap(update),/JUDGE_STATE_CONFLICT/);
  await assert.rejects(store.compareAndSwap({...update,version:1,document:{ownerCapability:a}}),/JUDGE_STATE_INVALID/);
  sqlite.exec('update vdj_rooms set expires_at_ms=0');await assert.rejects(store.compareAndSwap({...update,version:1}),/JUDGE_DENIED/);
 }finally{sqlite.close();}
});
test('R2 binding supports the existing immutable private store and rejects cross-room or overwritten media',async()=>{
 const objects=new Map();const bucket={async head(key){return objects.get(key)??null;},
  async get(key){const v=objects.get(key);return v?{...v,size:v.bytes.length,body:new Blob([v.bytes]).stream()}:null;},
  async put(key,bytes,options){if(objects.has(key)&&options.onlyIf?.etagDoesNotMatch==='*')return null;
   const value={bytes:Uint8Array.from(bytes),httpMetadata:options.httpMetadata};objects.set(key,value);return value;}};
 const transport=createR2RoomTransport({bucket,roomId:nonce,privateBucketApproved:true});
 const store=createSupabasePrivateStore({enabled:true,roomId:nonce,transport});
 const input={id:'synthetic-json',bytes:new TextEncoder().encode('{"synthetic":true}'),contentType:'application/json',binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap'}};
 const first=await store.assetStore.save(input);assert.equal((await store.assetStore.read(input.id)).sha256,first.sha256);
 await assert.rejects(store.assetStore.save({...input,bytes:new TextEncoder().encode('{"changed":true}')}),/IMMUTABLE_CONFLICT/);
 await assert.rejects(transport.readObject({bucket:'ai-vdj-private',path:'rooms/foreign/assets/example.json',maximumBytes:1024}),/R2_PRIVATE_STORAGE_HOLD/);
 await assert.rejects(transport.signObject(),/R2_PROVIDER_DELIVERY_NOT_CONNECTED/);
 store.close();transport.close();
});
