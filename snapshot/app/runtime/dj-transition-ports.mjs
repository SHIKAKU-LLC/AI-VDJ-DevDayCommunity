import {evaluateTransition, selectBestTransition} from './dj-transition-selector.mjs';

// Inject into createParticipantRooms. loadReceipts is a trusted server DSP/cache
// port returning receipts for candidate × rendered plan, never browser data.
export function createDJPorts({loadReceipts, mode = 'provider'}) {
  if (typeof loadReceipts !== 'function') throw Error('TRUSTED_RENDER_RECEIPT_PORT_REQUIRED');
  return {
    evaluatePlan:input=>evaluateTransition({...input,mode}),
    selectPlan:selectBestTransition,
    async inspectJoin({roomId, current, candidate, policy}) {
      const receipts = await loadReceipts({roomId, current, candidate, policy});
      if (!Array.isArray(receipts)) throw Error('RENDER_RECEIPTS_ARRAY_REQUIRED');
      if (!receipts.length) return null;
      const pairs = receipts.map(pairQC => ({pairQC, plan:evaluateTransition({current, candidate,
        policy:policy?.dj ?? policy ?? {}, mode, pairQC})}));
      const decision = selectBestTransition(pairs.map(p => p.plan), {nearEqualTolerance:0});
      // Keep a rejected receipt for inspectable hold diagnostics if none passes.
      return (pairs.find(p => p.plan === decision.selected) ?? pairs.sort((a,b) => a.plan.reasons.length - b.plan.reasons.length)[0]).pairQC;
    },
  };
}
