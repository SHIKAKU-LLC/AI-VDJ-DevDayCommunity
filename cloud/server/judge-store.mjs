const codes=new Set(['JUDGE_CLOSED','JUDGE_DENIED','JUDGE_CAPACITY','JUDGE_BUDGET']);
export function createJudgeStore({query,eventId}={}){
 if(typeof query!=='function'||!/^judge-[a-z0-9-]{1,60}$/.test(eventId??''))throw Error('JUDGE_CONFIGURATION_REQUIRED');
 async function request(action,roomId,capability,payload={}){
  try{const r=await query('select public.vdj_judge_request($1,$2,$3,$4,$5) as result',[action,eventId,roomId,capability,payload]);
   return r.rows[0].result;
  }catch(e){throw Error(codes.has(e?.message)?e.message:'JUDGE_BACKEND_HOLD');}
 }
 return Object.freeze({create:({nonce,ownerToken,joinCode})=>request('create',null,ownerToken,{nonce,joinCode}),
  authorize:(roomId,capability)=>request('authorize',roomId,capability),
  reserve:({roomId,capability,planId,cents})=>request('reserve',roomId,capability,{planId,cents})});
}
