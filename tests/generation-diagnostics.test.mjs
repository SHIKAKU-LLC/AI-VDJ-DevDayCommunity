import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticReasons} from '../cloud/generation/diagnostics.mjs';
test('preserves bounded nested application reasons while excluding private error text',()=>{
 const root=Object.assign(Error('https://private.invalid/credential'),{code:'RUNTIME_HTTP_409_HOLD'});
 const transport=Object.assign(Error('private message'),{code:'RUNTIME_REQUEST_HOLD',cause:root});
 const stored=Object.assign(Error('private location'),{holdReason:'PRIVATE_STORE_TRANSPORT_TIMEOUT',cause:transport});
 const ingestion=Object.assign(Error('untrusted message'),{holdReason:'PRIVATE_INGESTION_FAILED',cause:stored});
 assert.deepEqual(diagnosticReasons(ingestion),['PRIVATE_INGESTION_FAILED','PRIVATE_STORE_TRANSPORT_TIMEOUT','RUNTIME_REQUEST_HOLD','RUNTIME_HTTP_409_HOLD']);
 root.cause=ingestion;assert.equal(diagnosticReasons(ingestion).length,4);
 assert.deepEqual(diagnosticReasons(Error('https://private.invalid/credential')),['EXECUTION_HOLD']);
 assert.deepEqual(diagnosticReasons(Error('PRIVATE_UPPERCASE_TOKEN_VALUE')),['EXECUTION_HOLD']);
 assert.deepEqual(diagnosticReasons({holdReason:'PRIVATE_UPPERCASE_TOKEN_VALUE',code:'PORTABLE_QC_HOLD'}),['PORTABLE_QC_HOLD']);
 assert.deepEqual(diagnosticReasons(Error('a'.repeat(1000))),['EXECUTION_HOLD']);
});
