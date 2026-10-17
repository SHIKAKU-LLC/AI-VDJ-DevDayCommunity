import test from 'node:test';
import assert from 'node:assert/strict';
import {startResidentWorker} from '../cloud/worker/worker-entry.mjs';
test('resident entry is dormant on import and refuses activation before configuration access',async()=>{
 const configuration=new Proxy({},{get(){assert.fail('disabled entry must not inspect runtime configuration');}});
 await assert.rejects(startResidentWorker({activated:false,configuration}),/EXPLICIT_WORKER_ACTIVATION_REQUIRED/);
 await assert.rejects(startResidentWorker({activated:true}),/EXPLICIT_WORKER_ACTIVATION_REQUIRED/);
});
