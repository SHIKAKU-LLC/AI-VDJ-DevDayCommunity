import test from "node:test";
import assert from "node:assert/strict";
import { playbackState, playbackPlan, eligibleSets, claimNext, acknowledgeStart } from "../cloud/cloudflare/playback-queue.mjs";
import { preparePlaybackDecision, requestPlaybackDecision, decisionRequest, DECISIONS_MAX_CALLS } from "../cloud/cloudflare/playback-decisions.mjs";

const job = (id, participantId, order) => ({
  id, participantId, submissionOrder: order, submittedAtMs: order,
  createdAtMs: 100 - order, readyAtMs: 200 - order,
  profile: "audience-12-v1", state: "READY",
  assets: { audio: { duration: 12 }, video: { duration: 12 } },
});
const env = { DECISIONS_ENABLED: "true", OPENAI_API_KEY: "placeholder" };
const clientId = "11111111-1111-4111-8111-111111111111";
const jobs = [job("a1", "a", 1), job("a2", "a", 2), job("b1", "b", 3), job("c1", "c", 4)];
function afterFirst() {
  const state = playbackState();
  const nonce = crypto.randomUUID();
  claimNext(state, jobs, [], { clientId, nonce, readyIds: jobs.map((j) => j.id), now: 0 });
  acknowledgeStart(state, { clientId, nonce, id: "a1", now: 0 });
  return state;
}
const answer = (choice = "DEFER_REPEAT") => Response.json({ answers: [{ type: "choice", name: "playback_action", choice }] });

test("FIFO uses receipt time and receipt order rather than generation completion or UUID", () => {
  const state = playbackState();
  assert.deepEqual(eligibleSets([jobs[3], jobs[1], jobs[0], jobs[2]], state).map((j) => j.id), ["a1", "a2", "b1", "c1"]);
  const tied = [job("z-first", "a", 1), job("a-second", "b", 2)].map((j) => ({ ...j, submittedAtMs: 10 }));
  assert.equal(eligibleSets(tied.reverse(), state)[0].id, "z-first");
});

test("everyone gets a turn, deferred posts are retained, restart and repeated acknowledgements do not duplicate", () => {
  let state = playbackState();
  const played = [];
  for (let turn = 0; turn < 4; turn++) {
    const nonce = crypto.randomUUID();
    const claim = claimNext(state, jobs, [], { clientId, nonce, readyIds: jobs.map((j) => j.id), now: turn * 12000 });
    played.push(claim.id);
    assert.deepEqual(claimNext(state, jobs, [], { clientId, nonce, readyIds: [], now: turn * 12000 }), claim);
    assert.equal(acknowledgeStart(state, { clientId, nonce, id: claim.id, now: turn * 12000 }).counted, true);
    assert.equal(acknowledgeStart(state, { clientId, nonce, id: claim.id, now: turn * 12000 }).counted, false);
    state = structuredClone(state);
  }
  assert.deepEqual(played, ["a1", "b1", "c1", "a2"]);
  assert.deepEqual(state.counts, { a: 2, b: 1, c: 1 });
  assert.equal(eligibleSets(jobs, state).length, 0);
});

test("same participant yields to the earliest different participant, even when counts are equal", () => {
  const state = afterFirst();
  state.counts.b = 1;
  state.counts.c = 1;
  assert.equal(playbackPlan(jobs, state).nextId, "b1");
  assert.equal(playbackPlan(jobs, state).action, "DEFER_REPEAT");
  state.lastParticipantId = "c";
  assert.equal(playbackPlan(jobs, state).nextId, "a2");
});

test("a single participant keeps playing; loading and failed media never drop queued posts", () => {
  const state = afterFirst();
  const partiallyReady = jobs.map((j) => j.id === "b1" ? { ...j, state: "PROCESSING" } : j.id === "c1" ? { ...j, state: "FAILED" } : j);
  assert.equal(playbackPlan(partiallyReady, state).nextId, "a2");
  assert.equal(playbackPlan(jobs, state, ["a2"]).action, "PLAY_HEAD");
  const claim = claimNext(state, jobs, [], { clientId, nonce: crypto.randomUUID(), readyIds: ["a2"], now: 1 });
  assert.equal(claim.id, "a2");
  assert.ok(!state.played.includes("b1"));
  assert.ok(!state.played.includes("a2"));
});

test("normal FIFO, idle rooms, disabled flag and absent secret make no API reservations", () => {
  const state = afterFirst();
  assert.equal(preparePlaybackDecision(playbackState(), jobs, env, 0), null);
  assert.equal(preparePlaybackDecision(state, jobs, { ...env, DECISIONS_ENABLED: "false" }, 1), null);
  assert.equal(preparePlaybackDecision(state, jobs, { DECISIONS_ENABLED: "true" }, 1), null);
  assert.equal(preparePlaybackDecision(state, jobs, env, 15001), null);
  assert.equal(preparePlaybackDecision(state, [jobs[1]], env, 1), null);
  assert.equal(state.decisions, undefined);
});

test("reservation survives eviction and the per-room API cap is enforced", () => {
  let state = afterFirst();
  const plan = preparePlaybackDecision(state, jobs, env, 1);
  assert.equal(plan.headId, "a2");
  state = structuredClone(state);
  assert.equal(preparePlaybackDecision(state, jobs, env, 2), null);
  assert.equal(state.decisions.calls, 1);
  state.decisions = { attemptedHeads: [], calls: DECISIONS_MAX_CALLS };
  assert.equal(preparePlaybackDecision(state, jobs, env, 2), null);
});

test("fixed choice request contains only aggregate facts and a valid response is used by the claim", async () => {
  const state = afterFirst();
  const plan = preparePlaybackDecision(state, jobs.map((j) => ({ ...j, prompt: "private prompt", nickname: "private nickname", reference: "private reference" })), env, 1);
  let calls = 0;
  const result = await requestPlaybackDecision(plan, { key: "placeholder", fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/decisions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.get("authorization"), "Bearer placeholder");
    const input = JSON.parse(options.body);
    assert.equal(input.model, "gpt-6-luna");
    assert.deepEqual(JSON.parse(input.input), { head_adopted_count: 1, next_adopted_count: 0, head_is_previous_participant: true, next_is_different_participant: true });
    assert.deepEqual(input.questions[0].choices.map((c) => c.value), ["PLAY_HEAD", "DEFER_REPEAT"]);
    assert.ok(!options.body.includes("private"));
    assert.ok(!options.body.includes("a2"));
    return answer();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "ready", action: "DEFER_REPEAT" });
  const decision = { key: plan.key, ...result };
  const claim = claimNext(state, jobs, [], { clientId, nonce: crypto.randomUUID(), readyIds: ["b1", "c1"], now: 1, decision });
  assert.equal(claim.id, "b1");
  assert.deepEqual(state.lastSelection, { id: "b1", source: "decisions", action: "DEFER_REPEAT" });
});

test("wrong action, refusal, missing/duplicate answer, wrong name, unknown choice and bad JSON fall back", async () => {
  const plan = playbackPlan(jobs, afterFirst());
  const responses = [
    [() => answer("PLAY_HEAD"), "rejected"],
    [() => answer("DELETE"), "invalid"],
    [() => Response.json({ answers: [{ type: "refusal", name: "playback_action" }] }), "invalid"],
    [() => Response.json({ answers: [{ type: "choice", name: "other", choice: "DEFER_REPEAT" }] }), "invalid"],
    [() => Response.json({ answers: [{ type: "choice", name: "playback_action", choice: "DEFER_REPEAT" }, {}] }), "invalid"],
    [() => Response.json({}), "invalid"],
    [() => new Response("invalid JSON"), "unavailable"],
    [() => new Response(null, { status: 429 }), "unavailable"],
    [() => new Response(null, { status: 503 }), "unavailable"],
    [() => { throw Error("synthetic transport failure"); }, "unavailable"],
  ];
  for (const [response, status] of responses) {
    let calls = 0;
    const advice = await requestPlaybackDecision(plan, { key: "placeholder", fetchImpl: async () => { calls++; return response(); } });
    assert.equal(advice.status, status);
    assert.equal(calls, 1);
    const state = afterFirst();
    assert.equal(claimNext(state, jobs, [], { clientId, nonce: crypto.randomUUID(), readyIds: ["a2", "b1", "c1"], now: 1, decision: { key: plan.key, ...advice } }).id, "b1");
    assert.equal(state.lastSelection.source, "rules");
  }
});

test("deadline bounds both headers and body, aborts fetch and does not retry", async () => {
  const plan = playbackPlan(jobs, afterFirst());
  for (const body of [false, true]) {
    let signal, calls = 0;
    const result = await requestPlaybackDecision(plan, { key: "placeholder", timeoutMs: 10, fetchImpl: async (_url, options) => {
      calls++;
      signal = options.signal;
      return body ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
    } });
    assert.equal(result.status, "timeout");
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
});

test("stale result cannot pick a played or undecoded candidate", () => {
  const state = afterFirst();
  const plan = playbackPlan(jobs, state);
  const decision = { key: plan.key, status: "ready", action: "DEFER_REPEAT" };
  state.played.push("b1");
  state.counts.b = 1;
  const claim = claimNext(state, jobs, [], { clientId, nonce: crypto.randomUUID(), readyIds: ["a2", "c1"], now: 1, decision });
  assert.equal(claim.id, "c1");
  assert.equal(state.lastSelection.source, "rules");
  const single = afterFirst();
  assert.equal(claimNext(single, jobs, [], { clientId, nonce: crypto.randomUUID(), readyIds: ["a2"], now: 1, decision }).id, "a2");
  assert.equal(single.lastSelection.source, "rules");
  assert.equal(decisionRequest(plan).questions.length, 1);
});

// Diagnostics are fixed codes only; never return provider bodies or credentials.
test("HTTP failures expose only status and do not read the provider error body", async () => {
  const plan = playbackPlan(jobs, afterFirst());
  const result = await requestPlaybackDecision(plan, {key: "placeholder", fetchImpl: async () => ({
    ok: false, status: 401, json() { throw Error("error body must not be read"); },
  })});
  assert.deepEqual(result, {status: "unavailable", httpStatus: 401});
});

test("Workers-compatible redirect handling never follows a redirect with credentials", async () => {
  const plan = playbackPlan(jobs, afterFirst());
  let calls = 0;
  const result = await requestPlaybackDecision(plan, {key: "placeholder", fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/decisions");
    assert.equal(init.redirect, "manual");
    return new Response(null, {status: 307, headers: {location: "https://example.invalid/redirect"}});
  }});
  assert.deepEqual(result, {status: "unavailable", httpStatus: 307});
  assert.equal(calls, 1);
});

test("request setup and transport failures return fixed phases without error messages", async () => {
  const plan = playbackPlan(jobs, afterFirst());
  let calls = 0;
  const malformed = await requestPlaybackDecision(plan, {key: "placeholder\ninvalid", fetchImpl: async () => {calls++;}});
  assert.deepEqual(malformed, {status: "unavailable", phase: "headers"});
  assert.equal(calls, 0);
  const network = await requestPlaybackDecision(plan, {key: "placeholder", fetchImpl: async () => {throw Error("private transport detail");}});
  assert.deepEqual(network, {status: "unavailable", phase: "request"});
});
