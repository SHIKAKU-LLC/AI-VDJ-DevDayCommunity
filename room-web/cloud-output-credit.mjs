const nicknameValid = value => typeof value === 'string' && value === value.normalize('NFKC') &&
  [...value].length >= 1 && [...value].length <= 40 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);

export function projectCloudPlaybackCredit(credit, binding) {
  if (!credit || !binding || !Number.isSafeInteger(binding.operationId) || binding.operationId < 1 ||
      !Number.isSafeInteger(binding.expectedRevision) || binding.expectedRevision < 1 ||
      credit.cueId !== binding.cueId || credit.generationId !== binding.generationId ||
      credit.playbackRevision !== binding.expectedRevision || credit.actual !== true || credit.actualPlayback !== true ||
      credit.roomId !== undefined && credit.roomId !== binding.roomId || !nicknameValid(credit.nickname))
    throw Error('CLOUD_ACTUAL_CREDIT_REQUIRED');
  return {operationId: binding.operationId, roomId: binding.roomId, cueId: binding.cueId,
    generationId: binding.generationId, playbackRevision: binding.expectedRevision,
    nickname: credit.nickname, actual: true, actualPlayback: true};
}

// The text overlay is deliberately independent of all audio/visual media routes.
// It receives server-accepted credit only after the actual browser ACK. Never
// use ready/reserved state, preload, source-start ACK or a participant prompt.
export function createCloudCreditOverlay({element, readPlayback, readBinding,
  schedule = setTimeout, cancel = clearTimeout} = {}) {
  if (!element || typeof readPlayback !== 'function' || typeof readBinding !== 'function' ||
      typeof schedule !== 'function' || typeof cancel !== 'function') throw Error('CLOUD_CREDIT_OVERLAY_REQUIRED');
  let timer = null, lastRevision = 0, disposed = false;
  function clear() { if (timer !== null) cancel(timer); timer = null; element.textContent = ''; element.hidden = true; }
  clear();
  return {
    show(data) {
      if (disposed || !data || Object.keys(data).some(k => !['operationId', 'roomId', 'cueId', 'generationId',
        'playbackRevision', 'nickname', 'actual', 'actualPlayback'].includes(k))) throw Error('CLOUD_CREDIT_MESSAGE_INVALID');
      const binding = readBinding(), credit = projectCloudPlaybackCredit(data, binding), state = readPlayback();
      if (data.operationId !== binding.operationId || state.phase !== 'PLAYING' || state.audioStarted !== true ||
          state.videoPresented !== true || state.cueId !== credit.cueId || state.playbackRevision !== credit.playbackRevision)
        throw Error('CLOUD_CREDIT_OUTPUT_NOT_PLAYING');
      if (credit.playbackRevision <= lastRevision) return {shown: false, duplicate: true};
      clear(); lastRevision = credit.playbackRevision;
      // Literal text only: a nickname cannot create markup, URLs or handlers.
      element.textContent = credit.nickname; element.hidden = false;
      timer = schedule(clear, 6000);
      return {shown: true, cueId: credit.cueId, playbackRevision: credit.playbackRevision};
    },
    observePlaybackState(state) {
      // A queued future cue does not revoke the already accepted six-second
      // nickname for the current audible cue. Stops/holds/fresh graphs do.
      if (['STOPPED', 'HOLD', 'IDLE', 'GESTURE_REQUIRED', 'MONITOR'].includes(state?.phase)) clear();
    },
    clear,
    // A Stop -> Start graph restarts revisions from the source; forget the
    // previous graph's revisions so its first Cue credit is not a "duplicate".
    reset() { clear(); lastRevision = 0; },
    dispose() { disposed = true; clear(); },
  };
}
