import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createD1JudgeStore } from "../cloud/cloudflare/d1-store.mjs";
import { createAudienceRoomClass } from "../cloud/cloudflare/audience-room.mjs";
import { createGenerationClass } from "../cloud/cloudflare/generation-runtime.mjs";
import { createGenerationStore } from "../cloud/cloudflare/generation-store.mjs";
import {
  MODELS,
  REFERENCE_VIDEO_MODEL,
  sha256,
} from "../cloud/cloudflare/fal-provider.mjs";
import {
  claimNext,
  acknowledgeStart,
  playbackState,
  eligibleSets,
} from "../cloud/cloudflare/playback-queue.mjs";
import { generationHttp } from "../cloud/cloudflare/generation-http.mjs";
import { audienceHttp } from "../cloud/cloudflare/audience-http.mjs";
import { referenceImageHttp } from "../cloud/cloudflare/reference-image.mjs";
import { referencePng } from "./helpers/reference-png.mjs";
import { createPresetBatchClass } from "../cloud/cloudflare/preset-batch.mjs";
import { createSetPlayer } from "../room-web/judge-set-player.mjs";

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    await readFile(
      new URL("../cloud/cloudflare/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite
    .prepare("insert into vdj_events values(?,1,?,100,37500)")
    .run("judge-audience", Date.now() + 3600000);
  const db = {
    prepare: (sql) => ({
      bind(...args) {
        const q = sqlite.prepare(sql);
        return {
          async first() {
            return q.get(...args) ?? null;
          },
          async all() {
            return { results: q.all(...args) };
          },
          async run() {
            return { meta: { changes: Number(q.run(...args).changes) } };
          },
        };
      },
    }),
  };
  db.batch = async (statements) => {
    sqlite.exec("begin");
    try {
      const rows = [];
      for (const q of statements) rows.push(await q.run());
      sqlite.exec("commit");
      return rows;
    } catch (e) {
      sqlite.exec("rollback");
      throw e;
    }
  };
  const storage = () => {
    const values = new Map();
    return {
      values,
      async get(k) {
        return structuredClone(values.get(k));
      },
      async put(k, v) {
        values.set(k, structuredClone(v));
      },
      async delete(k) {
        values.delete(k);
      },
      async setAlarm(n) {
        values.set("alarm", n);
      },
      async getAlarm() {
        return values.get("alarm");
      },
      async deleteAlarm() {
        values.delete("alarm");
      },
    };
  };
  const posted = [],
    pool = new Map(),
    objects = new Map();
  const env = {
    DB: db,
    EVENT_ID: "judge-audience",
    PUBLIC_ORIGIN: "https://test.example",
    AUDIENCE_MODE: "true",
    GENERATION_ENABLED: "true",
    FAL_KEY: "synthetic-test-value",
    MEDIA: {
      async get(k) {
        const o = objects.get(k);
        return o ? { ...o, body: new Blob([o.bytes]).stream() } : null;
      },
      async head(k) {
        return objects.get(k);
      },
      async put(k, b, o) {
        if (!(b instanceof Uint8Array))
          b = new Uint8Array(await new Response(b).arrayBuffer());
        objects.set(k, {
          size: b.length,
          bytes: b,
          etag: "synthetic-etag",
          httpMetadata: o.httpMetadata,
          customMetadata: o.customMetadata,
        });
      },
    },
    testFetch: async (url, opts) => {
      if (String(url).includes("pricing"))
        return Response.json({
          prices: Object.values({
            ...MODELS,
            reference: REFERENCE_VIDEO_MODEL,
          }).map((endpoint_id) => ({
            endpoint_id,
            currency: "USD",
            unit: endpoint_id.includes("audio") ? "audios" : "seconds",
            unit_price: 0.03,
          })),
        });
      if (opts?.method === "POST") {
        const id = crypto.randomUUID();
        posted.push({ id, input: JSON.parse(opts.body), url: String(url) });
        return Response.json({
          request_id: id,
          status_url: `https://queue.fal.run/a/requests/${id}/status`,
          response_url: `https://queue.fal.run/a/requests/${id}`,
        });
      }
      if (String(url).endsWith("/status"))
        return Response.json({ status: "COMPLETED" });
      if (String(url).includes("queue.fal.run"))
        return Response.json({
          audio: { url: "https://v3.fal.media/a" },
          video: { url: "https://v3.fal.media/v" },
        });
      return new Response(new Uint8Array([1, 2, 3]));
    },
    NATIVE_PROCESSOR: {
      getByName: () => ({
        async fetch(r) {
          const a = {
            data: "AQID",
            sha256: await sha256(new Uint8Array([1, 2, 3])),
          };
          return Response.json({
            audio: a,
            video: a,
            context: a,
            duration: 12,
            width: 1920,
            height: 1080,
            quality: { passed: true },
          });
        },
      }),
    },
  };
  const Runtime = createGenerationClass(class {});
  env.GENERATION_JOBS = {
    getByName(name) {
      if (!pool.has(name))
        pool.set(name, new Runtime({ storage: storage() }, env));
      return pool.get(name);
    },
  };
  const Room = createAudienceRoomClass(class {}),
    coordinator = new Room({ storage: storage() }, env);
  env.AUDIENCE_ROOMS = { getByName: () => coordinator };
  const owner = "a".repeat(64),
    join = "b".repeat(64),
    room = await createD1JudgeStore({ db, eventId: env.EVENT_ID }).create({
      nonce: crypto.randomUUID(),
      ownerToken: owner,
      joinCode: join,
    });
  const call = (op, capability, payload = {}) =>
    coordinator.roomOperation({
      op,
      room_id: room.roomId,
      capability,
      payload,
    });
  return {
    sqlite,
    db,
    env,
    owner,
    join,
    room,
    coordinator,
    call,
    pool,
    posted,
  };
}
const job = (id, participantId, time) => ({
  id,
  participantId,
  readyAtMs: time,
  profile: "audience-12-v1",
  state: "READY",
  assets: { audio: { duration: 12 }, video: { duration: 12 } },
});
test("30 simultaneous participants persist full prompts outside the room and dispatch all 60 parts before any completes", async () => {
  const f = await fixture();
  try {
    const actors = Array.from({ length: 30 }, () =>
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    );
    await Promise.all(
      actors.map((token, i) =>
        f.call("join", f.join, {
          nickname: "合成人物" + i,
          participantCapability: token,
        }),
      ),
    );
    const payloads = actors.map((_, i) => ({
      nonce: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      prompt: "合成の音と光".repeat(190) + i,
    }));
    let interpreted = 0;
    f.env.IMAGE_DIRECTION_ENABLED = "true";
    f.env.AI = {
      async run() {
        interpreted++;
        return {
          answer: JSON.stringify({
            kind: "illustration",
            subject: "a synthetic cube",
            features: ["square silhouette"],
            palette: ["cyan"],
            summary: "合成図形",
          }),
        };
      },
    };
    await Promise.all(
      actors
        .filter((_, i) => i % 2 === 0)
        .map(async (token, n) => {
          const item = payloads[n * 2];
          const response = await referenceImageHttp(
            new Request(
              `https://test.example/api/rooms/${f.room.roomId}/reference-image/${item.nonce}`,
              {
                method: "PUT",
                headers: new Headers([
                  ["origin", "https://test.example"],
                  ["content-type", "image/png"],
                  ["authorization", "Bearer " + token],
                  ["x-vdj-prompt-sha256", await sha256(item.prompt)],
                ]),
                body: referencePng(),
              },
            ),
            f.env,
          );
          assert.equal(response.status, 201);
        }),
    );
    const receipts = await Promise.all(
      actors.map((token, i) => f.call("submit", token, payloads[i])),
    );
    assert.equal(new Set(receipts.map((r) => r.submissionId)).size, 30);
    assert.equal(
      f.sqlite.prepare("select count(*) n from vdj_submissions").get().n,
      30,
    );
    assert.ok(
      f.sqlite.prepare("select length(document) n from vdj_rooms").get().n <
        16000,
    );
    const privateView = await f.call("read", actors[0]);
    assert.equal(privateView.submissions.length, 1);
    assert.equal(privateView.participants.length, 1);
    await f.coordinator.alarm();
    assert.equal(f.pool.size, 30);
    await Promise.all([...f.pool.values()].map((runtime) => runtime.alarm()));
    assert.equal(f.posted.length, 60);
    assert.equal(interpreted, 15);
    assert.ok(f.posted.every((p) => p.input.duration === 12));
    assert.equal(
      f.posted.filter((p) => p.url.includes("outpainting")).length,
      0,
    );
    await Promise.all([...f.pool.values()].map((runtime) => runtime.alarm()));
    const records = await createGenerationStore({
      db: f.db,
      eventId: f.env.EVENT_ID,
      normalized: true,
    }).records(f.room.roomId);
    assert.equal(records.filter((j) => j.state === "READY").length, 30);
    assert.ok(records.every((j) => j.sceneCount === 1));
    await f.call("submit", actors[0], payloads[0]);
    await f.coordinator.alarm();
    await Promise.all([...f.pool.values()].map((runtime) => runtime.alarm()));
    assert.equal(f.posted.length, 60);
    assert.equal(
      f.sqlite.prepare("select sum(cents) n from vdj_budget_reservations").get()
        .n,
      7500,
    );
    const visible = await (
      await generationHttp(
        new Request(
          `https://test.example/api/rooms/${f.room.roomId}/generation`,
          { headers: new Headers([["authorization", "Bearer " + actors[0]]]) },
        ),
        f.env,
      )
    ).json();
    assert.equal(visible.jobs.length, 1);
    assert.equal(visible.remainingSets, 120);
    assert.equal(visible.playback, undefined);
  } finally {
    f.sqlite.close();
  }
});
test("fair playback prioritises first adoption, skips unfinished work and counts a start exactly once across restart", () => {
  const s = playbackState(),
    a = job("a", "frequent", 1),
    b = job("b", "new", 2),
    c = job("c", "newer", 3);
  s.counts.frequent = 3;
  const clientId = crypto.randomUUID(),
    nonce = crypto.randomUUID();
  assert.equal(
    claimNext(s, [a, b, { ...c, state: "GENERATING" }], [], {
      clientId,
      nonce,
      readyIds: ["a", "b", "c"],
      now: 1,
    }).id,
    "b",
  );
  assert.equal(
    acknowledgeStart(s, { clientId, nonce, id: "b", now: 2 }).counted,
    true,
  );
  const restored = structuredClone(s);
  assert.equal(
    acknowledgeStart(restored, { clientId, nonce, id: "b", now: 3 }).counted,
    false,
  );
  assert.equal(restored.counts.new, 1);
  assert.equal(eligibleSets([a, b, c], restored)[0].id, "c");
  assert.throws(
    () =>
      claimNext(restored, [a, c], [], {
        clientId: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        readyIds: ["a"],
        now: 4,
      }),
    /PLAYBACK_IN_USE/,
  );
});
test("all 38 presets play before repetition and a fresh generated set always wins the next boundary", () => {
  const s = playbackState(),
    clientId = crypto.randomUUID(),
    presets = Array.from({ length: 38 }, (_, i) => ({ id: "preset:" + i })),
    seen = [];
  for (let i = 0; i < 38; i++) {
    const nonce = crypto.randomUUID();
    const c = claimNext(s, [], presets, {
      clientId,
      nonce,
      readyIds: presets
        .filter((p) => !seen.includes(p.id))
        .slice(0, 8)
        .map((p) => p.id),
      now: i * 12000,
      random: () => 0,
    });
    seen.push(c.id);
    acknowledgeStart(s, { clientId, nonce, id: c.id, now: i * 12000 + 1 });
  }
  assert.equal(new Set(seen).size, 38);
  assert.equal(s.counts.owner, undefined);
  const nonce = crypto.randomUUID(),
    fresh = job("fresh", "owner", 1);
  const c = claimNext(s, [fresh], presets, {
    clientId,
    nonce,
    readyIds: ["fresh", presets[0].id],
    now: 38 * 12000,
  });
  assert.equal(c.id, "fresh");
});
test("a new owner cannot invoke playback for another room and public input cannot create a preset batch", async () => {
  const f = await fixture();
  try {
    const url = `https://test.example/api/rooms/${f.room.roomId}/playback`;
    assert.equal(
      (
        await audienceHttp(
          new Request(url, { headers: { "x-room-owner": "c".repeat(64) } }),
          f.env,
        )
      ).status,
      403,
    );
    const response = await generationHttp(
      new Request(url.replace("playback", "generation"), {
        method: "POST",
        headers: {
          origin: "https://test.example",
          "content-type": "application/json",
          "x-room-owner": f.owner,
        },
        body: JSON.stringify({ submissionIds: [crypto.randomUUID()] }),
      }),
      f.env,
    );
    assert.equal(response.status, 409);
  } finally {
    f.sqlite.close();
  }
});
test("twelve-second shared clock survives a late selection without cutting the current pair", async () => {
  let now = 0;
  const starts = [];
  const context = {
    get currentTime() {
      return now;
    },
    state: "running",
    async resume() {},
    createBufferSource() {
      return {
        connect() {},
        disconnect() {},
        start(at, offset, duration) {
          starts.push({ at, duration });
        },
        stop() {},
      };
    },
    createGain() {
      return {
        connect() {},
        disconnect() {},
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
      };
    },
  };
  const set = { id: "preset-a", buffer: { duration: 12 } },
    changes = [];
  const player = createSetPlayer({
    context,
    choose: async () => set,
    fallback: () => set,
    onStart: (s) => changes.push(s.id),
    setTimer() {},
    clearTimer() {},
  });
  await player.start();
  now = 0.1;
  player.tick();
  now = 10.2;
  player.tick();
  await Promise.resolve();
  await Promise.resolve();
  now = 12.1;
  player.tick();
  assert.deepEqual(
    starts.map((s) => s.duration),
    [12, 12],
  );
  assert.ok(Math.abs(starts[1].at - starts[0].at - 12) < 0.0001);
  player.stop();
  assert.equal(player.read().running, false);
});

test("optional image generates exactly one twelve-second reference video and one independent audio", async () => {
  const f = await fixture();
  try {
    f.env.IMAGE_DIRECTION_ENABLED = "true";
    let analyzed = 0;
    f.env.AI = {
      async run() {
        analyzed++;
        return {
          answer: JSON.stringify({
            kind: "illustration",
            subject: "a synthetic cube mascot",
            features: ["square silhouette"],
            palette: ["cyan"],
            summary: "合成図形を動かします。",
          }),
        };
      },
    };
    const nonce = "d".repeat(64),
      prompt = "青い光";
    const response = await referenceImageHttp(
      new Request(
        `https://test.example/api/rooms/${f.room.roomId}/reference-image/${nonce}`,
        {
          method: "PUT",
          headers: {
            origin: "https://test.example",
            "content-type": "image/png",
            "x-room-owner": f.owner,
            "x-vdj-prompt-sha256": await sha256(prompt),
          },
          body: referencePng(),
        },
      ),
      f.env,
    );
    assert.equal(response.status, 201);
    await f.call("submit", f.owner, { nonce, nickname: "合成", prompt });
    await f.coordinator.alarm();
    for (let n = 0; n < 3; n++)
      await Promise.all([...f.pool.values()].map((p) => p.alarm()));
    assert.equal(analyzed, 1);
    assert.equal(
      f.posted.length,
      2,
      JSON.stringify(
        (
          await createGenerationStore({
            db: f.db,
            eventId: f.env.EVENT_ID,
            normalized: true,
          }).records(f.room.roomId)
        ).map((j) => ({
          state: j.state,
          failures: j.failures,
          direction: j.direction?.state,
        })),
      ),
    );
    const video = f.posted.find((p) => p.url.includes(REFERENCE_VIDEO_MODEL));
    assert.equal(video.input.duration, 12);
    assert.equal(video.input.reference_image_urls.length, 1);
  } finally {
    f.sqlite.close();
  }
});
test("simultaneous reservations stop at the shared budget without losing accepted submissions", async () => {
  const f = await fixture();
  try {
    f.sqlite.exec("update vdj_events set maximum_cents=1000");
    const actors = Array.from({ length: 8 }, () =>
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    );
    await Promise.all(
      actors.map((participantCapability, i) =>
        f.call("join", f.join, { nickname: "合成" + i, participantCapability }),
      ),
    );
    await Promise.all(
      actors.map((token) =>
        f.call("submit", token, { nonce: crypto.randomUUID(), prompt: "低音" }),
      ),
    );
    await f.coordinator.alarm();
    assert.equal(
      f.sqlite.prepare("select sum(cents) n from vdj_budget_reservations").get()
        .n,
      1000,
    );
    assert.equal(
      f.sqlite.prepare("select count(*) n from vdj_submissions").get().n,
      8,
    );
    const jobs = await createGenerationStore({
      db: f.db,
      eventId: f.env.EVENT_ID,
      normalized: true,
    }).records(f.room.roomId);
    assert.equal(jobs.filter((j) => j.reason === "JUDGE_BUDGET").length, 4);
  } finally {
    f.sqlite.close();
  }
});

test("preparation reserves at most four slots before downloading and later jobs make progress", async () => {
  const f = await fixture();
  try {
    const actors = Array.from({ length: 10 }, () =>
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    );
    await Promise.all(
      actors.map((participantCapability, i) =>
        f.call("join", f.join, { nickname: "合成" + i, participantCapability }),
      ),
    );
    await Promise.all(
      actors.map((token) =>
        f.call("submit", token, { nonce: crypto.randomUUID(), prompt: "低音" }),
      ),
    );
    await f.coordinator.alarm();
    await Promise.all([...f.pool.values()].map((p) => p.alarm()));
    const native = f.env.NATIVE_PROCESSOR.getByName(),
      slots = new Map();
    let active = 0,
      peak = 0;
    f.env.NATIVE_POOL_SIZE = "4";
    f.env.NATIVE_PROCESSOR.getByName = (name) => ({
      async reserve(id) {
        if (slots.has(name)) return false;
        slots.set(name, id);
        active++;
        peak = Math.max(peak, active);
        return true;
      },
      async release(id) {
        assert.equal(slots.get(name), id);
        slots.delete(name);
        active--;
      },
      async fetch(r) {
        await new Promise((resolve) => setImmediate(resolve));
        return native.fetch(r);
      },
    });
    for (let n = 0; n < 12; n++)
      await Promise.all([...f.pool.values()].map((p) => p.alarm()));
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(active, 0);
    assert.equal(
      (
        await createGenerationStore({
          db: f.db,
          eventId: f.env.EVENT_ID,
          normalized: true,
        }).records(f.room.roomId)
      ).filter((j) => j.state === "READY").length,
      10,
    );
    assert.equal(f.posted.length, 20);
  } finally {
    f.sqlite.close();
  }
});
test("operator-approved preset batch registers 38 pairs within one reservation and never buys again on restart", async () => {
  const f = await fixture();
  try {
    const items = [];
    for (let i = 0; i < 38; i++) {
      const sha = await sha256("preset" + i);
      f.sqlite
        .prepare(
          "insert into vdj_curated_scenes values(?,?,3,12,1920,1080,1,?)",
        )
        .run(f.env.EVENT_ID, sha, Date.now());
      items.push({
        id: crypto.randomUUID(),
        videoSha: sha,
        prompt: "synthetic music " + i,
      });
    }
    const batchId = crypto.randomUUID();
    f.sqlite
      .prepare("insert into vdj_preset_batches values(?,?,?,1,?)")
      .run(f.env.EVENT_ID, batchId, f.room.roomId, JSON.stringify({ items }));
    const values = new Map(),
      storage = {
        async get(k) {
          return structuredClone(values.get(k));
        },
        async put(k, v) {
          values.set(k, structuredClone(v));
        },
        async setAlarm(t) {
          values.set("alarm", t);
        },
        async deleteAlarm() {
          values.delete("alarm");
        },
      };
    const Batch = createPresetBatchClass(class {}),
      batch = new Batch({ storage }, f.env);
    await batch.startBatch(f.room.roomId, batchId);
    for (let n = 0; n < 23; n++) await batch.alarm();
    assert.equal(f.posted.length, 38);
    assert.equal(
      f.sqlite.prepare("select count(*) n from vdj_curated_audio").get().n,
      38,
    );
    const restarted = new Batch({ storage }, f.env);
    await restarted.startBatch(f.room.roomId, batchId);
    await restarted.alarm();
    assert.equal(f.posted.length, 38);
    assert.equal(
      f.sqlite.prepare("select sum(cents) n from vdj_budget_reservations").get()
        .n,
      400,
    );
  } finally {
    f.sqlite.close();
  }
});

test("journal migration preserves legacy media and reservations while moving future posts out of the room row", async () => {
  const f = await fixture();
  try {
    const doc = JSON.parse(
      f.sqlite.prepare("select document from vdj_rooms").get().document,
    );
    const id = crypto.randomUUID();
    doc.submissions = [
      {
        submissionId: id,
        participantId: "owner",
        nickname: "合成",
        prompt: "従来の投稿",
      },
    ];
    f.sqlite
      .prepare("update vdj_rooms set document=?")
      .run(JSON.stringify(doc));
    f.sqlite
      .prepare("insert into vdj_budget_reservations values(?,?,?,?,?)")
      .run(f.env.EVENT_ID, f.room.roomId, id, 1500, Date.now());
    f.sqlite.exec(
      await readFile(
        new URL("../cloud/cloudflare/audience-migration.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      f.sqlite.prepare("select count(*) n from vdj_submissions").get().n,
      1,
    );
    await f.call("submit", f.owner, {
      nonce: crypto.randomUUID(),
      nickname: "合成",
      prompt: "新しい投稿",
    });
    assert.equal((await f.call("read", f.owner)).submissions.length, 2);
    assert.equal(
      JSON.parse(
        f.sqlite.prepare("select document from vdj_rooms").get().document,
      ).submissions.length,
      0,
    );
    assert.equal(
      f.sqlite.prepare("select sum(cents) n from vdj_budget_reservations").get()
        .n,
      1500,
    );
    assert.deepEqual(f.sqlite.prepare("pragma foreign_key_check").all(), []);
  } finally {
    f.sqlite.close();
  }
});

test("stopping during asynchronous selection cannot start late audio", async () => {
  let release;
  const selection = new Promise((resolve) => {
    release = resolve;
  });
  let scheduled = 0;
  const context = {
    currentTime: 0,
    async resume() {},
    createBufferSource() {
      scheduled++;
      return { connect() {}, start() {}, stop() {} };
    },
    createGain() {
      return {
        connect() {},
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
      };
    },
  };
  const player = createSetPlayer({
    context,
    choose: () => selection,
    fallback: () => null,
    setTimer() {},
    clearTimer() {},
  });
  const start = player.start();
  await Promise.resolve();
  player.stop();
  release({ id: "late", buffer: { duration: 12 } });
  await start;
  assert.equal(scheduled, 0);
  assert.equal(player.read().running, false);
});

test("a newly registered preset is used before repeating the completed initial library", () => {
  const state = playbackState(),
    clientId = crypto.randomUUID();
  const presets = [{ id: "preset:one" }, { id: "preset:two" }];
  for (const item of presets) {
    const nonce = crypto.randomUUID();
    claimNext(state, [], presets, {
      clientId,
      nonce,
      readyIds: [item.id],
      now: 1,
    });
    acknowledgeStart(state, { clientId, nonce, id: item.id, now: 2 });
  }
  presets.push({ id: "preset:three" });
  const next = claimNext(state, [], presets, {
    clientId,
    nonce: crypto.randomUUID(),
    readyIds: presets.map((p) => p.id),
    now: 3,
  });
  assert.equal(next.id, "preset:three");
});
