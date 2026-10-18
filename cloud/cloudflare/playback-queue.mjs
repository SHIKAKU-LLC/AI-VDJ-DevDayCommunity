const fail = (reason) => {
  throw Error(reason);
};
export const playbackState = () => ({
  counts: {},
  played: [],
  lastParticipantId: null,
  presetsPlayed: [],
  lastPreset: null,
  receipts: {},
  revision: 0,
});
function fifoSets(jobs, state) {
  return jobs
    .filter(
      (j) =>
        j.profile === "audience-12-v1" &&
        j.state === "READY" &&
        j.assets?.audio?.duration === 12 &&
        j.assets?.video?.duration === 12 &&
        !state.played.includes(j.id),
    )
    .sort(
      (a, b) =>
        (a.submittedAtMs ?? a.createdAtMs ?? a.readyAtMs ?? 0) -
          (b.submittedAtMs ?? b.createdAtMs ?? b.readyAtMs ?? 0) ||
        (a.submissionOrder ?? 0) - (b.submissionOrder ?? 0) ||
        a.id.localeCompare(b.id),
    );
}
export function eligibleSets(jobs, state) {
  const queue = fifoSets(jobs, state).sort(
    (a, b) => (state.counts[a.participantId] ?? 0) -
      (state.counts[b.participantId] ?? 0),
  );
  if (queue[0]?.participantId === state.lastParticipantId) {
    const next = queue.findIndex((j) => j.participantId !== state.lastParticipantId);
    if (next > 0) queue.unshift(...queue.splice(next, 1));
  }
  return queue;
}

// The model may choose an action, never an arbitrary submission or a ranking.
// Recompute this plan at claim time, including the browser's decoded media.
export function playbackPlan(jobs, state, readyIds) {
  const playable = readyIds ? jobs.filter((j) => readyIds.includes(j.id)) : jobs;
  const head = fifoSets(playable, state)[0];
  if (!head) return null;
  const next = eligibleSets(playable, state)[0];
  const headCount = state.counts[head.participantId] ?? 0;
  const nextCount = state.counts[next.participantId] ?? 0;
  return {
    key: JSON.stringify([head.id, next.id, headCount, nextCount, state.lastParticipantId ?? null]),
    headId: head.id,
    nextId: next.id,
    action: head.id === next.id ? "PLAY_HEAD" : "DEFER_REPEAT",
    facts: {
      head_adopted_count: headCount,
      next_adopted_count: nextCount,
      head_is_previous_participant: head.participantId === state.lastParticipantId,
      next_is_different_participant: head.participantId !== next.participantId,
    },
  };
}
export function assertLease(state, clientId, now) {
  if (!/^[a-f0-9-]{36}$/.test(clientId ?? "")) fail("PLAYBACK_CLIENT_INVALID");
  if (
    state.lease &&
    state.lease.until > now &&
    state.lease.clientId !== clientId
  )
    fail("PLAYBACK_IN_USE");
  state.lease = { clientId, until: now + 15000 };
}
export function claimNext(
  state,
  jobs,
  presets,
  { clientId, nonce, readyIds, decision, now = Date.now(), random = Math.random },
) {
  assertLease(state, clientId, now);
  if (
    state.pending &&
    state.pending.clientId === clientId &&
    state.pending.nonce === nonce
  )
    return state.pending;
  if (state.pending && state.pending.until > now)
    fail("PLAYBACK_CLAIM_PENDING");
  if (
    !/^[a-f0-9-]{36}$/.test(nonce ?? "") ||
    !Array.isArray(readyIds) ||
    readyIds.length > 8
  )
    fail("PLAYBACK_INPUT_INVALID");
  const ready = new Set(readyIds);
  // The browser warms the fair queue, so the deferred FIFO head may have been
  // unloaded already. Its media need not be decoded to let a ready peer play.
  const prepared = playbackPlan(jobs, state);
  const plan = prepared && ready.has(prepared.nextId)
    ? prepared : playbackPlan(jobs, state, readyIds);
  const advice = decision;
  const accepted = plan && advice?.key === plan.key &&
    advice.status === "ready" && advice.action === plan.action;
  const action = accepted ? advice.action : plan?.action;
  const selectedId = action === "PLAY_HEAD" ? plan.headId : plan?.nextId;
  const chosen = jobs.find((j) => j.id === selectedId);
  let item;
  if (chosen)
    item = {
      id: chosen.id,
      kind: "generated",
      participantId: chosen.participantId,
    };
  else {
    const available = presets.filter((p) => ready.has(p.id));
    let unseen = available.filter((p) => !state.presetsPlayed.includes(p.id));
    // A partially loaded browser must not reset the room's cycle early.
    const allUsed =
      presets.length > 0 &&
      presets.every((p) => state.presetsPlayed.includes(p.id));
    if (!unseen.length && allUsed) {
      state.presetsPlayed = [];
      unseen = available.filter(
        (p) => p.id !== state.lastPreset || presets.length === 1,
      );
    }
    if (unseen.length)
      item = {
        ...unseen[Math.floor(random() * unseen.length)],
        kind: "preset",
      };
  }
  if (!item) return null;
  state.lastSelection = {
    id: item.id,
    source: chosen ? (accepted ? "decisions" : "rules") : "preset",
    action: chosen ? action : "PLAY_PRESET",
  };
  state.pending = {
    id: item.id,
    kind: item.kind,
    participantId: item.participantId,
    clientId,
    nonce,
    until: now + 15000,
  };
  state.revision++;
  return state.pending;
}
export function acknowledgeStart(
  state,
  { clientId, nonce, id, now = Date.now() },
) {
  assertLease(state, clientId, now);
  if (state.receipts[nonce]?.id === id) return { counted: false };
  const pending = state.pending;
  if (
    !pending ||
    pending.clientId !== clientId ||
    pending.nonce !== nonce ||
    pending.id !== id ||
    pending.until < now
  )
    fail("PLAYBACK_CLAIM_INVALID");
  if (pending.kind === "generated" && !state.played.includes(id)) {
    state.played.push(id);
    state.counts[pending.participantId] =
      (state.counts[pending.participantId] ?? 0) + 1;
    state.lastParticipantId = pending.participantId;
  } else if (pending.kind === "preset") {
    if (!state.presetsPlayed.includes(id)) state.presetsPlayed.push(id);
    state.lastPreset = id;
  }
  state.receipts[nonce] = { id, at: now };
  const receipts = Object.entries(state.receipts)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 100);
  state.receipts = Object.fromEntries(receipts);
  state.pending = null;
  state.revision++;
  return { counted: true };
}
