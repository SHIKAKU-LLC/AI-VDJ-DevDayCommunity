import {createPortableNativeRuntime} from '../worker/native-runtime.mjs';
// All rooms share two CPU slots. Waiting work is bounded and cannot start
// after the event deadline; browser requests cannot choose this limit.
export function createServerNativeLoader({expiresAtMs,now=Date.now,createRuntime=createPortableNativeRuntime}={}){
 let active=0;const waiting=[];
 async function limited(invoke){
  if(now()>=expiresAtMs||waiting.length>=40)throw Error('JUDGE_CPU_HOLD');
  if(active>=2)await new Promise((resolve,reject)=>waiting.push({resolve,reject}));else active++;
  try{if(now()>=expiresAtMs)throw Error('JUDGE_CPU_HOLD');return await invoke();}
  finally{const next=waiting.shift();if(next)next.resolve();else active--;}
 }
 return async options=>{
  const runtime=await createRuntime(options);
  return {...runtime,native:Object.fromEntries(Object.entries(runtime.native).map(([name,fn])=>
   [name,(...args)=>limited(()=>fn(...args))])),
   inspectBootstrap:(...args)=>limited(()=>runtime.inspectBootstrap(...args)),
   inspectReference:(...args)=>limited(()=>runtime.inspectReference(...args))};
 };
}
