import {fileURLToPath} from 'node:url';
import {createNativeInspectors} from '../qc/native-inspectors.mjs';
import {createPrototypePipeline} from '../runtime/prototype-pipeline.mjs';
import {createRenderResolver} from '../runtime/render-resolver.mjs';

// Native composition only. Cloud descriptor/permit access is injected by its
// owner; no credential, provider submission, URL issuer or ledger is invented.
export function createMacPrototypeRuntime({roomId, store, readCurrent, signal,
  readOperation, readVisualPlan, readSavedRecord, readExactReview,
  readReservation, isReservationCurrent, fetchImpl = globalThis.fetch,
  native = createNativeInspectors({dspModule: fileURLToPath(new URL('../../snapshot/app/runtime/dj-transition-dsp.py', import.meta.url))})}) {
  if (![readCurrent, readOperation, readVisualPlan, readReservation, isReservationCurrent].every(f => typeof f === 'function'))
    throw Error('TRUSTED_OWNER_ADAPTERS_REQUIRED');
  let closed = false; const pending = new Set();
  function check(id = roomId) { if (id !== roomId || closed || signal?.aborted) throw Error('MAC_SESSION_ENDED'); }
  const current = async id => { check(id); const value = await readCurrent(); check(id); return value; };
  const pipeline = createPrototypePipeline({store, readCurrent: current, native, readVisualPlan, readSavedRecord, readExactReview,
    readOperation: async input => { check(input.roomId); const result = await readOperation(input); check(); return result; },
    fetchImpl: (url, options) => { check(); return fetchImpl(url, {...options, signal}); }});
  const render = createRenderResolver({readCurrent: id => pipeline.currentForSelector(id),
    readRender: input => pipeline.readRender(input), readArtifact: id => store.read(id)});
  function track(fn) {
    check(); const work = Promise.resolve().then(fn); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  return {
    inspectGeneration: input => track(async () => { check(input.roomId); const result = await pipeline.inspectGeneration(input); check(); return result; }),
    inspectJoin: input => track(() => pipeline.inspectJoin(input)),
    currentForSelector: id => track(() => pipeline.currentForSelector(id)),
    readRender: input => track(async () => {
      check(input.roomId);
      const reservation = await readReservation(input);
      if (reservation?.roomId !== roomId || reservation.cue?.cueId !== input.cueId ||
          reservation.expectedRevision !== input.expectedRevision || !reservation.plan ||
          await isReservationCurrent(reservation) !== true) throw Error('CURRENT_RESERVATION_REQUIRED');
      const result = await render({...reservation, signal});
      check(); if (await isReservationCurrent(reservation) !== true) throw Error('CURRENT_RESERVATION_REQUIRED');
      return result;
    }),
    async close() { closed = true; pipeline.close(); await Promise.allSettled([...pending]); },
  };
}
