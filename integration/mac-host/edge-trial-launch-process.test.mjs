import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EDGE_TRIAL_ROOM_ID,EDGE_TRIAL_ROOM_EXPIRES_AT,EDGE_TRIAL_PROJECT_URL} from './edge-trial-launch.mjs';

test('opt-in dormant trial starts only a bounded loopback listener', async t => {
  const roomDeadline = Date.parse(EDGE_TRIAL_ROOM_EXPIRES_AT), current = Date.now();
  if (current + 10_000 >= roomDeadline) return t.skip('fixed room has expired');
  const dir = await mkdtemp(path.join('/tmp','vdj-edge-listener-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const manifestPath = path.join(dir,'trial.json'), activationFile = path.join(dir,'activation.json'),
    operationalApprovalFile = path.join(dir,'operation.json'),
    statusPath = path.join(dir,'status.json');
  const trialExpiresAt = new Date(Math.floor(Math.min(current+120_000,roomDeadline)/1000)*1000)
    .toISOString().replace('.000Z','Z');
  await writeFile(manifestPath,JSON.stringify({version:'ai-vdj-edge-trial-v1',roomId:EDGE_TRIAL_ROOM_ID,
    projectURL:EDGE_TRIAL_PROJECT_URL,cloudOrigin:'https://ai-vdj.vercel.app',
    roomExpiresAt:EDGE_TRIAL_ROOM_EXPIRES_AT,trialExpiresAt,mode:'dormant',activationFile,operationalApprovalFile}),{mode:0o600});
  const child=spawn(process.execPath,[fileURLToPath(new URL('./launch.mjs',import.meta.url)),EDGE_TRIAL_ROOM_ID],{
    stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,VDJ_MAC_EDGE_TRIAL_MANIFEST:manifestPath,
      VDJ_MAC_WAIT_START:'1',VDJ_MAC_NO_OPEN:'1',VDJ_MAC_BOOTSTRAP_FILE:'',VDJ_MAC_STATUS_FILE:statusPath}});
  t.after(()=>{try{child.kill('SIGTERM');}catch{}});
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('EDGE_TRIAL_LISTENER_TIMEOUT')),5000);
    child.once('message',value=>{clearTimeout(timer);resolve(value);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('EDGE_TRIAL_LISTENER_EXITED'));});
  });
  assert.equal(ready.type,'ready');assert.match(ready.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  const response=await fetch(ready.origin+'/api/status',{method:'POST',headers:{Origin:ready.origin,
    'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);
  const state=await response.json();assert.equal(state.listening,true);assert.equal(state.sessionActive,false);
  await assert.rejects(stat(activationFile),{code:'ENOENT'});
  const before=JSON.parse(await readFile(statusPath,'utf8'));
  assert(before.some(entry=>entry.event==='LISTENING'));
  assert(before.every(entry=>!['LOCAL_CODE_SHOWN','CLOUD_CODE_SHOWN'].includes(entry.event)));
  const exited=once(child,'exit');child.kill('SIGTERM');await exited;
  const after=JSON.parse(await readFile(statusPath,'utf8'));
  assert(after.some(entry=>entry.event==='PROCESS_STOPPING'&&entry.reason==='SIGTERM'));
});
