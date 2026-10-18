import { playbackPlan } from "./playback-queue.mjs";

export const DECISIONS_MODEL = "gpt-6-luna";
export const DECISIONS_TIMEOUT_MS = 800;
export const DECISIONS_MAX_CALLS = 100;

// Reserve once per deferred head before sending. Eviction, retries and polling
// cannot repeat a paid request. An interrupted request falls back to the rules.
export function preparePlaybackDecision(state, jobs, env, now = Date.now()) {
  if (env.DECISIONS_ENABLED !== "true" || !env.OPENAI_API_KEY ||
      !state.lease || state.lease.until <= now || state.pending) return null;
  const plan = playbackPlan(jobs, state);
  if (!plan || plan.action !== "DEFER_REPEAT") return null;
  const decisions = state.decisions ??= { attemptedHeads: [], calls: 0 };
  if (decisions.calls >= DECISIONS_MAX_CALLS ||
      decisions.attemptedHeads.includes(plan.headId)) return null;
  decisions.calls++;
  decisions.attemptedHeads.push(plan.headId);
  decisions.latest = { key: plan.key, status: "pending" };
  return plan;
}

export function decisionRequest(plan) {
  return {
    model: DECISIONS_MODEL,
    // No prompt, image, nickname, room ID, participant ID or submission ID.
    input: JSON.stringify(plan.facts),
    questions: [{
      type: "choice",
      name: "playback_action",
      instructions: "Keep submission FIFO. Defer the head only when next_is_different_participant is true and either head_adopted_count is greater than next_adopted_count or head_is_previous_participant is true. Otherwise play the head. Never judge creative content or popularity.",
      choices: [
        { value: "PLAY_HEAD", description: "Play the FIFO head; there is no repeat to defer." },
        { value: "DEFER_REPEAT", description: "Keep the head queued and let the server's earliest eligible different participant take this turn." },
      ],
    }],
  };
}

export async function requestPlaybackDecision(plan, {
  key, fetchImpl = fetch, timeoutMs = DECISIONS_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: "timeout" });
      controller.abort();
    }, timeoutMs);
  });
  const request = (async () => {
    let phase = "headers";
    try {
      const headers = new Headers([["authorization", ["Bearer", key].join(" ")], ["content-type", "application/json"]]);
      phase = "request";
      const response = await fetchImpl("https://api.openai.com/v1/decisions", {
        method: "POST",
        headers,
        body: JSON.stringify(decisionRequest(plan)),
        signal: controller.signal,
        // workerd rejects "error" before sending. Return redirects unchanged
        // so the non-2xx guard rejects them without forwarding credentials.
        redirect: "manual",
      });
      if (!response.ok) return { status: "unavailable", httpStatus: response.status };
      phase = "response";
      const payload = await response.json();
      const answers = payload?.answers;
      const answer = Array.isArray(answers) && answers.length === 1 ? answers[0] : null;
      if (answer?.type !== "choice" || answer.name !== "playback_action" ||
          !["PLAY_HEAD", "DEFER_REPEAT"].includes(answer.choice))
        return { status: "invalid" };
      if (answer.choice !== plan.action) return { status: "rejected" };
      return { status: "ready", action: answer.choice };
    } catch {
      return { status: "unavailable", phase };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
