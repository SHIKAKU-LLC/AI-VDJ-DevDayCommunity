import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
export const FAL_MODELS=Object.freeze(['fal-ai/stable-audio-3/medium/audio-outpainting','minimax/h3-max/image-to-video','fal-ai/stable-audio-3/medium/text-to-audio']);
export class ConnectionError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new ConnectionError(code);};
export function requireSameOrigin(req,{origin,publicDeployment=false}){let o;try{o=new URL(origin);}catch{fail('INVALID_DEPLOYMENT_ORIGIN');}if(publicDeployment&&o.protocol!=='https:')fail('HTTPS_REQUIRED');if(req.headers.origin!==o.origin)fail('SAME_ORIGIN_REQUIRED');if(!publicDeployment&&(req.headers['x-forwarded-host']||req.headers['x-forwarded-for']||req.headers['x-forwarded-proto']))fail('LOCAL_PROXY_REFUSED');}
export function suppliedKey(req){const v=req.headers['x-fal-key'];if(typeof v!=='string'||!v.trim()||v.length>4096||/[\r\n]/.test(v))fail('USER_KEY_REQUIRED');return v.trim();}
// Intended for createFalClient({credentials}), never global fal.config or env fallback.
export function createRequestScopedClient(req,{origin,publicDeployment,modelId,operation,factory}){
 requireSameOrigin(req,{origin,publicDeployment});if(!FAL_MODELS.includes(modelId)||!['submit','status','result','cancel','storage-init'].includes(operation))fail('TARGET_NOT_ALLOWED');const key=suppliedKey(req);if(typeof factory!=='function')fail('PUBLIC_RUNTIME_NOT_IMPLEMENTED');return factory({credentials:key});
}
// Adapter for the documented proxy auth hook. Missing incoming key throws; no FAL_KEY fallback.
export function requestFalAuthResolver(req,policy){return async()=>{requireSameOrigin(req,policy);return 'Key '+suppliedKey(req);};}
// Prototype ownership contract; production needs durable tenant storage. No key is stored here.
export function createJobOwnership({now=Date.now,ttlMs=15*60*1000}={}){const pepper=randomBytes(32),jobs=new Map();const proof=key=>createHmac('sha256',pepper).update(key).digest();return {record({requestId,modelId,key}){if(!FAL_MODELS.includes(modelId)||!requestId||jobs.has(requestId))fail('JOB_BINDING_REFUSED');jobs.set(requestId,{modelId,proof:proof(key),expires:now()+ttlMs});},assert({requestId,modelId,key}){const j=jobs.get(requestId);if(!j||j.modelId!==modelId||now()>=j.expires||!timingSafeEqual(j.proof,proof(key)))fail('JOB_OWNER_REQUIRED');return true;},clear(){jobs.clear();pepper.fill(0);}};}
