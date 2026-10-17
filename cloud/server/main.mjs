import {pathToFileURL} from 'node:url';
import {parseJudgeConfiguration} from './config.mjs';
import {createPinnedPgPoolFactory} from '../worker/production-io.mjs';
import {createJudgeStore} from './judge-store.mjs';
import {createJudgeCloudService} from './service.mjs';
import {createJudgeRoomFactory} from './room-runtime.mjs';
import {startJudgeHttpServer} from './http.mjs';

export async function startConfiguredJudgeServer({environment=process.env}={}){
 const c=parseJudgeConfiguration(JSON.parse(environment.VDJ_JUDGE_CONFIGURATION??'null'));
 async function password(){return environment.VDJ_DB_PASSWORD;}
 const factory=createPinnedPgPoolFactory({readConnection:async()=>({host:environment.VDJ_DB_HOST,
  port:6543,database:'postgres',user:environment.VDJ_DB_USER,password,
  ssl:{rejectUnauthorized:true,...(environment.VDJ_DB_CA?{ca:environment.VDJ_DB_CA}:{})}})});
 const policy={ssl:{rejectUnauthorized:true},connectionTimeoutMillis:8000,query_timeout:8000,
  statement_timeout:8000,lock_timeout:8000,max:4,idleTimeoutMillis:8000};
 const pool=await factory(policy);pool.on('error',()=>{});
 const createPool=async()=>({options:pool.options,connect:()=>pool.connect(),on:()=>{},end:async()=>{}});
 const withPlatformHeaders=async(_input,invoke)=>{
  const key=environment.VDJ_SUPABASE_SERVICE_KEY;
  if(typeof key!=='string'||key.length<20)throw Error('JUDGE_CONFIGURATION_REQUIRED');
  const headers=new Headers();
  headers.set('apikey',key);
  headers.set('authorization','Bearer '+key);
  return invoke(headers);
 };
 const rooms=createJudgeRoomFactory({configuration:c,createPool,withPlatformHeaders,
  readCredential:async()=>environment.VDJ_FAL_KEY,
  runtime:{python:environment.VDJ_QC_PYTHON??'/opt/venv/bin/python',ffmpeg:'/usr/bin/ffmpeg',ffprobe:'/usr/bin/ffprobe',
   dspModule:new URL('../../snapshot/app/runtime/dj-transition-dsp.py',import.meta.url).pathname}});
 const store=createJudgeStore({query:(...args)=>pool.query(...args),eventId:c.eventId});
 const service=createJudgeCloudService({configuration:c,store,createRuntime:input=>rooms.create(input),
  forwardRoom:request=>{
   const headers=new Headers({origin:c.origin});
   for(const name of ['content-type','authorization','x-room-owner'])if(request.headers.has(name))headers.set(name,request.headers.get(name));
   return fetch(c.projectURL+'/functions/v1/ai-vdj-room'+new URL(request.url).pathname+new URL(request.url).search,
    {method:request.method,headers,...(request.body?{body:request.body,duplex:'half'}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});
  }});
 let listener;
 try{
  await pool.query('select 1');
  listener=await startJudgeHttpServer({service,origin:c.origin,hostname:'0.0.0.0',port:Number(environment.PORT??8080)});
 }catch{await service.close();rooms.close();await pool.end();throw Error('JUDGE_STARTUP_HOLD');}
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;clearTimeout(expiry);await listener.close();rooms.close();await pool.end();};
 const expiry=setTimeout(()=>void close(),Math.max(0,c.expiresAtMs-Date.now()));
 return {close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const server=await startConfiguredJudgeServer();
  console.log('VDJ_JUDGE_SERVER_READY');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void server.close());
 }catch{console.error('VDJ_JUDGE_SERVER_STARTUP_HOLD');process.exitCode=1;}
}
