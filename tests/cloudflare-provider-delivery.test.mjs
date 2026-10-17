import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createD1JudgeStore} from '../cloud/cloudflare/d1-store.mjs';
import {createProviderDelivery} from '../cloud/cloudflare/provider-delivery.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../cloud/cloudflare/schema.sql', import.meta.url), 'utf8'));
  sqlite.prepare('insert into vdj_events values(?,1,?,10,1000)').run('judge-delivery', Date.now() + 3600000);
  const db = {prepare: sql => ({bind(...values) {
    const statement = sqlite.prepare(sql);
    return {async first() { return statement.get(...values) ?? null; },
      async run() { const r = statement.run(...values); return {meta: {changes: Number(r.changes)}}; }};
  }})};
  const store = createD1JudgeStore({db, eventId: 'judge-delivery'});
  const room = await store.create({nonce: crypto.randomUUID(), ownerToken: 'a'.repeat(64), joinCode: 'b'.repeat(64)});
  const path = 'rooms/' + cueDigest(room.roomId) + '/assets/context.media';
  let etag = 'original';
  const bucket = {
    async head(key) { return key === path ? {etag, size: 3, httpMetadata: {contentType: 'audio/wav'}} : null; },
    async get(key, options) {
      if (key !== path || options.onlyIf.etagMatches !== etag) return null;
      return {etag, size: 3, httpMetadata: {contentType: 'audio/wav'}, body: new Response(new Uint8Array([1, 2, 3])).body};
    },
  };
  const create = () => createProviderDelivery({db, bucket, origin: 'https://room.example.com', eventId: 'judge-delivery'});
  return {sqlite, room, path, create, mutate() { etag = 'changed'; }};
}

test('R2 delivery persists only a digest, remains bounded across restart and never exposes metadata files', async () => {
  const f = await fixture();
  try {
    const issued = await f.create().issue({roomId: f.room.roomId, path: f.path, expiresIn: 60});
    const document = f.sqlite.prepare("select record_id,document from vdj_runtime_records where kind='provider-delivery'").get();
    assert.ok(!JSON.stringify(document).includes(issued.url));
    assert.ok(!JSON.stringify(document).includes(new URL(issued.url).pathname.split('/').at(-1)));
    const delivery = f.create();
    const responses = await Promise.all(Array.from({length: 9}, () => delivery.handle(new Request(issued.url))));
    assert.equal(responses.filter(value => value.status === 200).length, 8);
    assert.equal(responses.filter(value => value.status === 404).length, 1);
    for (const response of responses.filter(value => value.status === 200)) {
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    await assert.rejects(delivery.issue({roomId: f.room.roomId, path: f.path.replace('.media', '.json'), expiresIn: 60}), /SCOPE_REQUIRED/);
    await assert.rejects(delivery.issue({roomId: crypto.randomUUID(), path: f.path, expiresIn: 60}), /SCOPE_REQUIRED/);
  } finally { f.sqlite.close(); }
});

test('R2 delivery rejects changed objects, expired or stopped rooms, range reads and excessive lifetimes', async () => {
  const f = await fixture();
  try {
    const delivery = f.create(), issued = await delivery.issue({roomId: f.room.roomId, path: f.path, expiresIn: 60});
    assert.equal((await delivery.handle(new Request(issued.url, {headers: {Range: 'bytes=0-1'}}))).status, 404);
    assert.equal((await delivery.handle(new Request(issued.url, {method: 'POST'}))).status, 404);
    await assert.rejects(delivery.issue({roomId: f.room.roomId, path: f.path, expiresIn: 3601}), /SCOPE_REQUIRED/);
    f.mutate();
    assert.equal((await delivery.handle(new Request(issued.url))).status, 404);
    f.sqlite.exec("update vdj_runtime_records set document=json_set(document,'$.expiresAtMs',0)");
    assert.equal((await delivery.handle(new Request(issued.url))).status, 404);
    const next = await delivery.issue({roomId: f.room.roomId, path: f.path, expiresIn: 60});
    f.sqlite.exec('update vdj_events set enabled=0');
    assert.equal((await delivery.handle(new Request(next.url))).status, 404);
  } finally { f.sqlite.close(); }
});
