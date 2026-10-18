const fail = (reason) => {
  throw Error(reason);
};
export const playbackState = () => ({
  counts: {},
  played: [],
  presetsPlayed: [],
  lastPreset: null,
  receipts: {},
  revision: 0,
});
export function eligibleSets(jobs, state) {
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
        (state.counts[a.participantId] ?? 0) -
          (state.counts[b.participantId] ?? 0) ||
        (a.readyAtMs ?? a.createdAtMs) - (b.readyAtMs ?? b.createdAtMs) ||
        a.id.localeCompare(b.id),
    );
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
  { clientId, nonce, readyIds, now = Date.now(), random = Math.random },
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
  const chosen = eligibleSets(jobs, state).find((j) => ready.has(j.id));
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
