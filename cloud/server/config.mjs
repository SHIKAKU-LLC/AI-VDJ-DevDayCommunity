const fail=()=>{throw Error('JUDGE_CONFIGURATION_REQUIRED');};
export function parseJudgeConfiguration(value,{now=Date.now}={}){
 if(!value||value.version!=='judge-cloud-v1'||value.approved!==true||
  !/^judge-[a-z0-9-]{1,60}$/.test(value.eventId??'')||value.origin!=='https://ai-vdj.vercel.app'||
  value.projectURL!=='https://sbrghwehlkptbnbxhymu.supabase.co'||
  !Number.isSafeInteger(value.expiresAtMs)||value.expiresAtMs<=now()||value.expiresAtMs>1792335540000||
  !Number.isSafeInteger(value.maximumRooms)||value.maximumRooms<1||value.maximumRooms>100||
  !Number.isSafeInteger(value.maximumCents)||value.maximumCents<250||value.maximumCents>20000||
  !Number.isSafeInteger(value.maximumResidentRooms)||value.maximumResidentRooms<1||value.maximumResidentRooms>20||
  typeof value.autoTopUp!=='boolean'||value.autoTopUp&&!value.topUpProtection||
  !Number.isSafeInteger(value.billingObservedAtMs)||value.billingObservedAtMs>now()||now()-value.billingObservedAtMs>3600000||
  !/^[a-f0-9]{64}$/.test(value.billingEvidenceSha256??'')||!value.bounds||
  !Number.isFinite(value.infrastructureMaximumUsd)||value.infrastructureMaximumUsd<0||value.infrastructureMaximumUsd>20)fail();
 const s=value.source;
 if(!s||!/^[a-f0-9-]{36}$/.test(s.roomId??''))fail();
 for(const name of ['audio','reference','video'])if(!s[name]||!/^[-A-Za-z0-9_]{1,100}$/.test(s[name].assetId??'')||! /^[a-f0-9]{64}$/.test(s[name].sha256??''))fail();
 return Object.freeze(structuredClone(value));
}
