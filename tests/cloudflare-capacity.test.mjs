import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createD1JudgeStore} from '../cloud/cloudflare/d1-store.mjs';
import {createD1RoomRpc} from '../cloud/cloudflare/room-api.mjs';
import {createGenerationStore} from '../cloud/cloudflare/generation-store.mjs';

const schema = await readFile(new URL('../cloud/cloudflare/schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../cloud/cloudflare/generation-capacity-migration.sql', import.meta.url), 'utf8');
const owner = 'a'.repeat(64), join = 'b'.repeat(64);
async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('pragma foreign_keys=on');
  sqlite.exec(schema.replace('between 50 and 37500', 'between 50 and 20000'));
  sqlite.prepare('insert into vdj_events values(?,1,?,100,15000)').run('judge-capacity', Date.now()+3600000);
  const db = {prepare: sql => ({bind(...args) {
    const s = sqlite.prepare(sql);
    return {async first() { return s.get(...args) ?? null; }, async all() { return {results:s.all(...args)}; },
      async run() { return {meta:{changes:Number(s.run(...args).changes)}}; }};
  }})};
  const roomStore = createD1JudgeStore({db,eventId:'judge-capacity'});
  const rpc = createD1RoomRpc({db,eventId:'judge-capacity'});
  const generation = createGenerationStore({db,eventId:'judge-capacity',policy:{audioSeconds:60,videoSeconds:12,sceneCount:6,mediaProfile:'club-flow-v1',maximumCents:1500,maximumSets:5}});
  const room = () => roomStore.create({nonce:crypto.randomUUID(),ownerToken:owner,joinCode:join});
  const submit = roomId => rpc({op:'submit',room_id:roomId,capability:owner,
    payload:{nonce:crypto.randomUUID(),nickname:'合成テスト',prompt:'低音の強いトランスと抽象映像'}});
  return {sqlite,room,submit,generation};
}

test('event capacity migration preserves budgets, rooms, records and foreign keys', async () => {
  const f = await fixture();
  try {
    const room = await f.room(), submission = await f.submit(room.roomId);
    await f.generation.enqueue(room.roomId,submission.submissionId);
    f.sqlite.prepare('insert into vdj_stock_sources values(?,?,?)').run(room.roomId,'judge-capacity',Date.now());
    const tables=['vdj_events','vdj_rooms','vdj_budget_reservations','vdj_runtime_records','vdj_stock_sources'];
    const snapshot=() => Object.fromEntries(tables.map(table=>[table,f.sqlite.prepare(`select * from ${table}`).all()]));
    const before=snapshot();
    assert.throws(()=>f.sqlite.prepare('update vdj_events set maximum_cents=37500').run(),/CHECK constraint/);
    f.sqlite.exec(`begin;${migration}commit;`);
    assert.deepEqual(snapshot(),before);
    assert.deepEqual(f.sqlite.prepare('pragma foreign_key_check').all(),[]);
    assert.equal(f.sqlite.prepare('pragma foreign_keys').get().foreign_keys,1);
    f.sqlite.prepare('update vdj_events set maximum_cents=37500').run();
    assert.throws(()=>f.sqlite.prepare('update vdj_events set maximum_cents=37501').run(),/CHECK constraint/);
    assert.throws(()=>f.sqlite.prepare('insert into vdj_budget_reservations values(?,?,?,?,?)').run(
      'judge-missing',room.roomId,'missing-event',1500,Date.now()),/FOREIGN KEY constraint/);
  } finally { f.sqlite.close(); }
});

test('five independent rooms can reserve five sets each within the expanded shared limit', async () => {
  const f = await fixture();
  try {
    f.sqlite.exec(`begin;${migration}commit;`);
    f.sqlite.prepare('update vdj_events set maximum_cents=37500').run();
    let first;
    for(let i=0;i<5;i++) {
      const room=await f.room();
      for(let j=0;j<5;j++) {
        const submission=await f.submit(room.roomId);
        const job=await f.generation.enqueue(room.roomId,submission.submissionId);
        first ??= job;
      }
      const sixth=await f.submit(room.roomId);
      await assert.rejects(f.generation.enqueue(room.roomId,sixth.submissionId),/JUDGE_BUDGET/);
    }
    assert.equal((await f.generation.enqueue(first.roomId,first.id)).id,first.id);
    const extraRoom=await f.room(), extraSubmission=await f.submit(extraRoom.roomId);
    await assert.rejects(f.generation.enqueue(extraRoom.roomId,extraSubmission.submissionId),/JUDGE_BUDGET/);
    assert.deepEqual(f.sqlite.prepare('select count(*) n,sum(cents) cents from vdj_budget_reservations').get(),
      Object.assign(Object.create(null),{n:25,cents:37500}));
    assert.deepEqual(f.sqlite.prepare('pragma foreign_key_check').all(),[]);
  } finally { f.sqlite.close(); }
});
