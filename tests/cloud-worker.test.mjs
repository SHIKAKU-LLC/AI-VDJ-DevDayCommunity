import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPortableCloudWorker} from '../cloud/worker/portable-worker.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function dependencies(extra={}) {
  return {readOperation:async()=>{throw Error('UNEXPECTED_LEDGER_READ');},readCurrent:async()=>null,
    readVisualPlan:async()=>null,assetStore:{read:async()=>null,save:async()=>null,verifySaved:async()=>null},...extra};
}
test('cloud CPU worker is disabled by default and ignores caller QC claims',async()=>{
  const worker=createPortableCloudWorker(dependencies());
  await assert.rejects(worker.inspectGeneration({roomId:'room',operation:{operationId:'operation',qc:{passed:true}}}),/NOT_ACTIVATED/);
  const result=await worker.processJob({roomId:'room',operationId:'operation'});
  assert.deepEqual(result.reasons,['CLOUD_WORKER_NOT_ACTIVATED']);assert.equal(result.evidence,null);
  assert.deepEqual((await worker.processJob({roomId:'room',operationId:'operation',qc:{passed:true}})).reasons,['CLOUD_JOB_IDS_ONLY']);
  await worker.close();
});
test('IDs and authoritative completion gate native work; original provider URL cannot be resolved',async()=>{
  let inspect=0,reads=0;
  const op={operationId:'operation',plan:{status:'COMPILED'},stages:{music:{state:'COMPLETE',result:{url:'https://example.invalid/media',resultSha256:'a'.repeat(64)}},video:{state:'COMPLETE'}}};
  const worker=createPortableCloudWorker(dependencies({enabled:true,readOperation:async()=>{reads++;return op;},
    native:{inspectAudio:async()=>{inspect++;},inspectVideo:async()=>{inspect++;}}}));
  assert.deepEqual((await worker.processJob({roomId:'room',operationId:'operation'})).reasons,['SAVED_MEDIA_REQUIRED']);
  assert.deepEqual((await worker.processJob({roomId:'room',operationId:'https://example.invalid'})).reasons,['CLOUD_JOB_IDS_ONLY']);
  assert.equal(reads,1);assert.equal(inspect,0);
  await worker.close();
});
test('private record hashes are verified before bootstrap; storage cannot assert a false checksum',async()=>{
  const bytes=Buffer.from('fixture'),records=new Map([['seed',{assetId:'seed',bytes,byteLength:bytes.length,sha256:sha(Buffer.from('different'))}],
    ['reference',{assetId:'reference',bytes,byteLength:bytes.length,sha256:sha(bytes)}]]);
  const worker=createPortableCloudWorker(dependencies({enabled:true,assetStore:{read:async id=>records.get(id),save:async()=>null,verifySaved:async()=>null}}));
  await assert.rejects(worker.prepareBootstrap({audioAssetId:'seed',audioSha256:sha(bytes),referenceAssetId:'reference',referenceSha256:sha(bytes)}),/CHECKSUM_MISMATCH/);
  await worker.close();
});
test('HOLD output sanitizes adapter errors and never includes URLs or local paths',async()=>{
  const worker=createPortableCloudWorker(dependencies({enabled:true,readOperation:async()=>{throw Error('failed https://example.invalid/private /local/private');}}));
  const result=await worker.processJob({roomId:'room',operationId:'operation'});
  assert.deepEqual(result.reasons,['CLOUD_WORKER_INSPECTION_FAILED']);assert.equal(result.evidence,null);
  await worker.close();
});
test('CPU admission is bounded before private-byte reads and HOLD exposes one coordinator error code',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const worker=createPortableCloudWorker(dependencies({enabled:true,readOperation:async()=>{await gate;return null;}}));
  const first=worker.processJob({roomId:'room',operationId:'first'}),second=worker.processJob({roomId:'room',operationId:'second'});
  assert.deepEqual((await worker.processJob({roomId:'room',operationId:'third'})).reasons,['NATIVE_QC_BUSY']);
  release();assert.equal((await first).status,'HOLD');assert.equal((await second).status,'HOLD');
  await assert.rejects(worker.inspectGeneration({roomId:'room',operationId:'fourth'}),error=>
    error.code==='PORTABLE_QC_HOLD'&&error.holdReason==='AUTHORITATIVE_OPERATION_REQUIRED');
  await worker.close();
});
