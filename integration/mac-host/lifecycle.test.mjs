import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {startIndependentProcess} from './process-owner.mjs';
import {createHostHealth} from './health.mjs';
import {readApprovedBootstrap} from './approved-bootstrap.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('detached real host survives its launcher termination and logs explicit shutdown',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vdj-lifecycle-')),status=path.join(dir,'status.json');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const launcher=path.join(dir,'launcher.mjs');
 await writeFile(launcher,`import {startIndependentProcess} from ${JSON.stringify(new URL('./process-owner.mjs',import.meta.url).href)};
 const ready=await startIndependentProcess({entry:${JSON.stringify(fileURLToPath(new URL('./launch.mjs',import.meta.url)))},args:['synthetic-room','https://room.example'],env:process.env});
 process.send(ready);setInterval(()=>{},1000);`);
 const parent=spawn(process.execPath,[launcher],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,VDJ_MAC_PORT:'0',VDJ_MAC_WAIT_START:'1',VDJ_MAC_NO_OPEN:'1',VDJ_MAC_STATUS_FILE:status,VDJ_MAC_BOOTSTRAP_FILE:''}});
 t.after(()=>{try{parent.kill('SIGKILL');}catch{}});
 const ready=await new Promise((resolve,reject)=>{parent.once('message',resolve);parent.once('error',reject);parent.once('exit',()=>reject(Error('launcher exited')));});
 t.after(()=>{try{process.kill(ready.pid,'SIGKILL');}catch{}});
 const check=async()=>{const r=await fetch(ready.origin+'/api/status',{method:'POST',headers:{Origin:ready.origin,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,200);return r.json();};
 assert.equal((await check()).sessionActive,false);
 const ended=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGTERM');await ended;
 let orphaned=false;
 for(let i=0;i<40;i++){if(Number(execFileSync('ps',['-o','ppid=','-p',String(ready.pid)],{encoding:'utf8'}).trim())===1){orphaned=true;break;}await wait(25);}
 assert.equal(orphaned,true);assert.equal((await check()).listening,true);
 // Separate OS process group/session, not just a child inheriting launcher group.
 const workerGroup=execFileSync('ps',['-o','pgid=','-p',String(ready.pid)],{encoding:'utf8'}).trim();
 assert.equal(Number(workerGroup),ready.pid);
 process.kill(ready.pid,'SIGTERM');
 let records=[];
 for(let i=0;i<40;i++){records=JSON.parse(await readFile(status,'utf8'));if(records.some(x=>x.event==='PROCESS_EXIT'))break;await wait(25);}
 assert(records.some(x=>x.event==='PROCESS_STOPPING'&&x.reason==='SIGTERM'));
 assert(records.some(x=>x.event==='PROCESS_EXIT'));
 assert(records.every(x=>Object.keys(x).every(k=>['event','reason','timeMs','pid','parentPid'].includes(k))));
});

test('failed worker startup returns only a fixed error',async()=>{
 await assert.rejects(startIndependentProcess({entry:'/nonexistent/synthetic-worker.mjs'}),/MAC_HOST_EXITED_BEFORE_READY/);
});

test('health shows outages, discards stale connection after two failures, and ignores late response on dispose',async()=>{
 let failed=false,resolve,hold=false;const jobs=[],states=[];
 const h=createHostHealth({check:async()=>{if(hold)await new Promise(r=>{resolve=r;});if(failed)throw Error('private');return {listening:true,sessionActive:true};},
  onState:s=>states.push(s),schedule:fn=>{jobs.push(fn);return jobs.length;},cancel:()=>{}});
 await wait(0);assert.equal(states.at(-1).online,true);
 failed=true;await jobs.shift()();assert.deepEqual(states.at(-1),{online:false,dropConnection:false});
 await jobs.shift()();assert.deepEqual(states.at(-1),{online:false,dropConnection:true});
 failed=false;await jobs.shift()();assert.equal(states.at(-1).online,true);
 hold=true;const before=states.length,pending=jobs.shift()();h.dispose();resolve();await pending;assert.equal(states.length,before);
});

test('approved bootstrap requires exact hashes and never passes paths to the prepare adapter',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vdj-approved-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const audio=Buffer.from('synthetic audio'),reference=Buffer.from('synthetic reference');
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const a=path.join(dir,'sample.wav'),r=path.join(dir,'sample.png'),m=path.join(dir,'manifest.json');
 await writeFile(a,audio);await writeFile(r,reference);
 const manifest={audio:{path:a,sha256:sha(audio)},reference:{path:r,sha256:sha(reference)}};
 await writeFile(m,JSON.stringify(manifest));let calls=0;
 const adapters={inspectImage:async b=>{assert.deepEqual(b,reference);return true;},prepare:async b=>{calls++;assert.deepEqual(Object.keys(b).sort(),['audioBytes','referenceBytes']);return 'prepared';}};
 assert.equal(await readApprovedBootstrap(m,adapters),'prepared');assert.equal(calls,1);
 await writeFile(a,'changed');await assert.rejects(readApprovedBootstrap(m,adapters),/APPROVED_BOOTSTRAP_CHANGED/);assert.equal(calls,1);
});
