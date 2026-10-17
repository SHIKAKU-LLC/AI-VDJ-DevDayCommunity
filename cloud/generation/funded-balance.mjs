// Auto top-up may stay enabled only under an explicit, fresh native approval
// to spend existing credits. The reserved run budget must never touch its trigger.
export function validTopUpProtection(value,{now=Date.now,requiredUsd=0}={}){
 return !!value&&Object.keys(value).sort().join(',')==='approved,evidenceSha256,kind,maximumSpendUsd,observedAtMs,thresholdUsd,topUpAmountUsd'&&
  value.kind==='existing-credit-only-v1'&&value.approved===true&&
  /^[a-f0-9]{64}$/.test(value.evidenceSha256??'')&&
  Number.isSafeInteger(value.observedAtMs)&&value.observedAtMs<=now()&&now()-value.observedAtMs<=3600000&&
  Number.isFinite(value.thresholdUsd)&&value.thresholdUsd>=0&&
  Number.isFinite(value.topUpAmountUsd)&&value.topUpAmountUsd>0&&
  Number.isFinite(value.maximumSpendUsd)&&value.maximumSpendUsd>0&&value.maximumSpendUsd<=2.5&&
  Number.isFinite(requiredUsd)&&requiredUsd>=0&&requiredUsd<=value.maximumSpendUsd;
}
export function acceptsFundedBalance(balance,{now=Date.now,requiredUsd=0}={}){
 if(!Number.isFinite(requiredUsd)||requiredUsd<0||!Number.isFinite(balance?.usd)||balance.usd<requiredUsd)return false;
 if(balance.autoTopUp===false)return true;
 return balance.autoTopUp===true&&validTopUpProtection(balance.topUpProtection,{now,requiredUsd})&&
  balance.usd-balance.topUpProtection.maximumSpendUsd>balance.topUpProtection.thresholdUsd;
}
