const UNCERTAIN_COMMIT = new Set(['CLOUD_OUTPUT_COMMIT_UNCERTAIN', 'CLOUD_OUTPUT_ACK_TIMEOUT']);
// The switch point has already sounded: retrying the same plan cannot succeed.
const LATE_EDIT = new Set(['QUEUED_RENDER_FRONTIER_CHANGED']);
// Optional host adapter. The existing owner and player are injected at mount.
// No provider key, media fetcher, second audio source or automatic mount exists.
export function createOwnerCueHost({request, roomId, ownerCapability, commitPlayback, activateAudio = () => {},
  stopPlayback = () => {}, onState = () => {}, lifecycle = globalThis.window,
  schedule = setTimeout, cancel = clearTimeout, intervalMs = 5000, retryDelayMs = 500, ackAttempts = 3, commitAttempts = 2} = {}) {
  if (typeof request !== 'function' || typeof commitPlayback !== 'function' ||
      !/^[a-f0-9-]{36}$/i.test(roomId ?? '') || !/^[a-f0-9]{64}$/.test(ownerCapability ?? '')) throw Error('OWNER_PLAYBACK_PORT_REQUIRED');
  let owner = ownerCapability, running = false, closed = false, epoch = 0, timer = null, active = null, starting = null, pendingAck = null;
  const emit = state => { try { onState(state); } catch {} };
  async function call(action, body = {}) {
    if (closed) throw Error('CUE_HOST_CLOSED');
    const headers = new Headers(); headers.set('X-Room-Owner', owner);
    return request(`/api/rooms/${roomId}/cues/${action}`, {method: 'POST', headers, body});
  }
  // The output page owns the playback clock. A failed network step never
  // stops sound here: the sole graph keeps playing its committed Cue and the
  // next pump retries. Only an explicit owner Stop/page hide ends the show.
  async function confirm(pending, alive) {
    const {reservation, ack} = pending;
    let result = null;
    for (let attempt = 0; attempt < ackAttempts && !result; attempt++) {
      if (!alive()) return;
      // cueAck is idempotent by ackSha256; repeating the POST never re-credits.
      try { result = await call('ack', {reservationId: reservation.reservationId, ack}); }
      catch { if (attempt + 1 < ackAttempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs)); }
    }
    if (!result) {
      // One read can reconcile a lost ACK response. Never replay the media.
      const snapshot = await call('state').catch(() => null);
      const credit = snapshot?.currentCredit;
      if (credit?.cueId !== reservation.cue.cueId || credit?.playbackRevision !== reservation.expectedRevision || credit.actual !== true) {
        // After its reservation expires the server can never accept this ACK
        // and keeps the pending lock. Stop retrying; the sounding Cue plays out
        // and the owner's explicit Stop -> Start clears the lock.
        if (Number.isFinite(reservation.expiresAtMs) && Date.now() >= reservation.expiresAtMs) {
          if (pendingAck === pending) pendingAck = null;
          if (alive()) { running = false; epoch++; cancel(timer); timer = null; }
          throw Error('PLAYBACK_RESERVATION_EXPIRED_STOP_START_REQUIRED');
        }
        throw Error('PLAYBACK_ACK_UNKNOWN_NO_REPLAY');
      }
      result = {accepted: true, reconciled: true, currentCredit: credit};
    }
    if (!alive()) return;
    if (result.accepted !== true || result.currentCredit?.cueId !== reservation.cue.cueId ||
        result.currentCredit?.playbackRevision !== reservation.expectedRevision || result.currentCredit?.actual !== true)
      throw Error('PLAYBACK_ACK_NOT_ACCEPTED');
    if (pendingAck === pending) pendingAck = null;
    emit({state: 'PLAYING', currentCredit: result.currentCredit}); return result;
  }
  async function once() {
    if (!running || closed) throw Error('CUE_HOST_NOT_RUNNING');
    if (active) return active;
    const revision = epoch, alive = () => revision === epoch && running && !closed;
    const work = (async () => {
      // A Cue that already sounds is confirmed before any further reservation.
      if (pendingAck) return confirm(pendingAck, alive);
      const reservation = await call('reserve');
      if (!alive()) return;
      if (reservation.state === 'HOLD') { emit(reservation); return reservation; }
      const reservationId = reservation.reservationId;
      if (!reservationId || reservation.roomId !== roomId || !reservation.cue || !reservation.plan) throw Error('PLAYBACK_RESERVATION_INVALID');
      emit({state: 'STAGING', cueId: reservation.cue.cueId});
      // The show-mode check reads only the reservation's own validity (cheap).
      // Concurrent guards share one in-flight request; every later guard,
      // including the final one before the audio edit, asks the server again
      // so a Stop or control change made meanwhile is seen before any edit.
      let checking = null;
      const input = {roomId, cue: reservation.cue, plan: reservation.plan,
        expectedRevision: reservation.expectedRevision, guard: async ({phase = 'prepare'} = {}) => {
          if (!alive()) return false;
          // The ACK RPC atomically rechecks reservation, expiry, Stop and control.
          if (phase === 'ack') return true;
          if (Number.isFinite(reservation.expiresAtMs) && Date.now() >= reservation.expiresAtMs) return false;
          const pending = checking ??= call('check', {reservationId, phase}).then(check => check.valid === true, () => false)
            .finally(() => { if (checking === pending) checking = null; });
          return await pending && alive();
        }};
      let ack;
      for (let attempt = 0; ; attempt++) {
        try { ack = await commitPlayback(input); break; }
        catch (error) {
          // A failure before the audio edit leaves the current Cue sounding.
          // Retry the same unexpired reservation once; never a second Cue.
          // An outcome the output could not report may already sound: no retry.
          if (attempt + 1 >= commitAttempts || !alive() || UNCERTAIN_COMMIT.has(error?.message) || LATE_EDIT.has(error?.reason) ||
              Number.isFinite(reservation.expiresAtMs) && Date.now() >= reservation.expiresAtMs) throw error;
        }
      }
      if (!alive()) return;
      const pending = {reservation, ack}; pendingAck = pending;
      return confirm(pending, alive);
    })();
    active = work;
    try { return await work; }
    catch (error) {
      const terminal = error?.message === 'PLAYBACK_RESERVATION_EXPIRED_STOP_START_REQUIRED';
      // A wire failure carries the output's own bounded reason code.
      const reason = error?.reason ? error.message + ':' + error.reason : error.message;
      if (terminal ? !closed : revision === epoch && running && !closed) emit({state: 'HOLD', reason});
      throw error;
    }
    finally { if (active === work) active = null; }
  }
  function pump() {
    if (!running || closed) return;
    // After an actual accepted AV ACK, prepare the next Cue while this finite
    // Cue is playing. Only waiting/HOLD polling uses the ordinary interval.
    void once().then(result=>result?.accepted===true?0:intervalMs,()=>intervalMs)
      .then(delay=>{if(running&&!closed)timer=schedule(pump,delay);});
  }
  async function stop(reason = 'OWNER_STOP') {
    running = false; epoch++; cancel(timer); timer = null; pendingAck = null;
    const outputStop = await stopPlayback(reason);
    // A page can be disposed before any graph was registered. Stopping its
    // cues would strand the room without a graph receipt that can restart it.
    if (outputStop?.graphStopConfirmed !== true) {
      if (outputStop?.stopped === true && outputStop.noGraph === true) {
        emit({state: 'STOPPED'}); return outputStop;
      }
      emit({state: 'HOLD', reason: 'CUE_STOP_UNCONFIRMED'}); throw Error('CUE_STOP_UNCONFIRMED');
    }
    // An unconfirmed server Stop can keep the pending reservation or credit.
    // Report it, so the controls stay in HOLD and Stop can be retried.
    let result;
    try { result = await call('stop'); }
    catch { emit({state: 'HOLD', reason: 'CUE_STOP_UNCONFIRMED'}); throw Error('CUE_STOP_UNCONFIRMED'); }
    emit({state: 'STOPPED', ...result}); return result;
  }
  const hide = () => { void stop('PAGE_HIDE').catch(() => {}).finally(() => { closed = true; owner = ''; }); };
  lifecycle?.addEventListener?.('pagehide', hide, {once: true});
  return {
    start() {
      if (closed) return Promise.reject(Error('CUE_HOST_CLOSED'));
      if (starting || running) return starting ?? Promise.resolve();
      const revision = ++epoch;
      const activation = activateAudio(); // Invoke synchronously; await before reserving playback.
      starting = (async () => {
        await activation;
        if (closed || epoch !== revision) return;
        await call('start');
        if (closed || epoch !== revision) return;
        running = true; pump();
      })().catch(async error => {
        if (epoch === revision) {
          running = false; epoch++;
          // The source graph may already be registered and sounding. Retire
          // it on the server as an explicit Stop would, so the next Start can
          // register a fresh graph. Both are best effort; the Start error and
          // HOLD are reported either way, and an explicit Stop can follow.
          // The output retires a registered graph and then stops the room's
          // cues only with that graph's Stop receipt; with no graph yet the
          // room is left unstopped so the next Start can register.
          await Promise.resolve().then(() => stopPlayback('CUE_HOST_START_FAILED')).catch(() => {});
          emit({state: 'HOLD', reason: error.message});
        }
        throw error;
      }).finally(() => { starting = null; });
      return starting;
    },
    once, stop,
    // A finite Cue that played to its end is not a room Stop: the room, its
    // credit and served counts stay. Only selection for the ended graph stops;
    // the owner restarts with Stop -> Start.
    halt(reason = 'CUE_DURATION_END') {
      running = false; epoch++; cancel(timer); timer = null; pendingAck = null;
      emit({state: 'HOLD', reason});
    },
    publish: operationId => call('publish', {operationId}),
    state: () => call('state'),
    async dispose() {
      try { await stop('DISPOSE'); } finally { closed = true; owner = ''; lifecycle?.removeEventListener?.('pagehide', hide); }
    },
  };
}
