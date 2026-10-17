const proof=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
const isCapability=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const fail=code=>{throw Error(code);};
const clock="cast(unixepoch('subsec')*1000 as integer)";
// D1 receives prepared statements only. Admission and budget limits are in
// conditional SQL writes, not a read/modify/write counter in worker memory.
export function createD1JudgeStore({db,eventId,now=Date.now}={}){
 if(!db?.prepare||!/^judge-[a-z0-9-]{1,60}$/.test(eventId??''))fail('JUDGE_CONFIGURATION_REQUIRED');
 const query=(sql,...values)=>db.prepare(sql).bind(...values);
 async function event(){const value=await query(`select * from vdj_events where id=? and enabled=1 and expires_at_ms>${clock}`,eventId).first();
  if(!value)fail('JUDGE_CLOSED');return value;}
 async function read(roomId,capability){await event();if(!uuid(roomId)||!isCapability(capability))fail('JUDGE_DENIED');
  const row=await query(`select * from vdj_rooms where event_id=? and id=? and owner_proof=? and expires_at_ms>${clock}`,eventId,roomId,await proof(capability)).first();
  if(!row)fail('JUDGE_DENIED');return row;}
 const snapshot=({document,id:roomId,epoch:sessionId,expires_at_ms:expiresAtMs})=>({...JSON.parse(document),roomId,sessionId,expiresAtMs});
 return Object.freeze({
  async create({nonce,ownerToken,joinCode}){
   const e=await event();if(!uuid(nonce)||!isCapability(ownerToken)||!isCapability(joinCode))fail('JUDGE_DENIED');
   const id=crypto.randomUUID(),epoch=crypto.randomUUID(),ownerProof=await proof(ownerToken),joinProof=await proof(joinCode);
   const document=JSON.stringify({eventSeq:0,controlRevision:0,closed:false,accepting:true,generationPaused:true,autoDJ:false,
    mode:'collect',cues:[],currentCredit:null,playbackAdapterAvailable:false,participants:[],submissions:[],operations:{}});
   await query(`insert into vdj_rooms(id,event_id,nonce,epoch,owner_proof,join_proof,expires_at_ms,document)
    select ?,e.id,?,?,?,?,min(e.expires_at_ms,${clock}+14400000),? from vdj_events e
    where e.id=? and e.enabled=1 and e.expires_at_ms>${clock}
    and (select count(*) from vdj_rooms r where r.event_id=e.id)<e.maximum_rooms
    on conflict(event_id,nonce) do nothing`,id,nonce,epoch,ownerProof,joinProof,document,eventId).run();
   const row=await query('select * from vdj_rooms where event_id=? and nonce=?',eventId,nonce).first();
   if(!row)fail('JUDGE_CAPACITY');if(row.owner_proof!==ownerProof||row.join_proof!==joinProof)fail('JUDGE_DENIED');
   if(row.expires_at_ms<=now()||e.expires_at_ms<=now())fail('JUDGE_CLOSED');
   return {...snapshot(row),ownerToken,joinCode};
  },
  async authorize(roomId,capability){const {id,epoch:sessionId,expires_at_ms:expiresAtMs}=await read(roomId,capability);return {roomId:id,sessionId,expiresAtMs};},
  async reserve({roomId,capability,planId,cents}){
   const row=await read(roomId,capability);
   if(!/^[A-Za-z0-9_-]{1,100}$/.test(planId??'')||![50,100,250].includes(cents))fail('JUDGE_DENIED');
   await query(`insert into vdj_budget_reservations(event_id,room_id,plan_id,cents,created_at_ms)
    select e.id,?,?,?,${clock} from vdj_events e join vdj_rooms r on r.event_id=e.id
    where e.id=? and r.id=? and r.owner_proof=? and e.enabled=1 and e.expires_at_ms>${clock} and r.expires_at_ms>${clock}
    and coalesce((select sum(b.cents) from vdj_budget_reservations b where b.event_id=e.id),0)+?<=e.maximum_cents
    and coalesce((select sum(b.cents) from vdj_budget_reservations b where b.room_id=r.id),0)+?<=250
    on conflict(event_id,plan_id) do nothing`,roomId,planId,cents,eventId,roomId,row.owner_proof,cents,cents).run();
   const saved=await query('select room_id,cents from vdj_budget_reservations where event_id=? and plan_id=?',eventId,planId).first();
   if(!saved)fail('JUDGE_BUDGET');if(saved.room_id!==roomId||saved.cents!==cents)fail('JUDGE_DENIED');return {reserved:true};
  },
  async readOwner(roomId,capability){return snapshot(await read(roomId,capability));},
  async compareAndSwap({roomId,capability,version,document}){
   const row=await read(roomId,capability);
   if(!Number.isSafeInteger(version)||version<0||!document||typeof document!=='object')fail('JUDGE_STATE_INVALID');
   const serialized=JSON.stringify(document);
   if(serialized.length>65536||/"(?:ownerToken|ownerCapability|apiKey|credential|password|authorization)"\s*:/i.test(serialized))fail('JUDGE_STATE_INVALID');
   const result=await query(`update vdj_rooms set document=?,version=version+1 where event_id=? and id=? and owner_proof=? and version=?
    and expires_at_ms>${clock} and exists(select 1 from vdj_events e where e.id=? and e.enabled=1 and e.expires_at_ms>${clock})`,
    serialized,eventId,roomId,row.owner_proof,version,eventId).run();
   if(result.meta.changes!==1)fail('JUDGE_STATE_CONFLICT');return {version:version+1};
  }
 });
}
