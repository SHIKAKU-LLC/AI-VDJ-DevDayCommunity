import test from 'node:test';
import assert from 'node:assert/strict';
import {prototypeAudioQCHold} from '../integration/runtime/prototype-pipeline.mjs';
import {diagnosticReasons} from '../cloud/generation/diagnostics.mjs';

test('audio admission failure preserves specific fixed causes without changing the public hold',()=>{
 const e=prototypeAudioQCHold(['TRUSTED_BYTE_ORIGIN_REQUIRED','FRESH_BOUND_AUDIO_MEASUREMENT_REQUIRED']);
 assert.equal(e.message,'PROTOTYPE_AUDIO_QC_HOLD');
 assert.deepEqual(diagnosticReasons(e),['PROTOTYPE_AUDIO_QC_HOLD','TRUSTED_BYTE_ORIGIN_REQUIRED','FRESH_BOUND_AUDIO_MEASUREMENT_REQUIRED']);
 assert.deepEqual(Object.keys(e),[]);
});
test('unknown values, raw locations and repeated codes cannot enter a diagnostic cause chain',()=>{
 const codes=['https://private.invalid/synthetic-secret','UNKNOWN_UPPERCASE_TOKEN',{},'SOURCE_AUDIO_QC_FAILED',
  'SOURCE_AUDIO_QC_FAILED','BOUND_NATIVE_TRANSITION_QC_REQUIRED'];
 assert.deepEqual(diagnosticReasons(prototypeAudioQCHold(codes)),
  ['PROTOTYPE_AUDIO_QC_HOLD','SOURCE_AUDIO_QC_FAILED','BOUND_NATIVE_TRANSITION_QC_REQUIRED']);
 assert.equal(JSON.stringify(prototypeAudioQCHold(codes)),'{}');
 assert.deepEqual(diagnosticReasons(prototypeAudioQCHold(null)),['PROTOTYPE_AUDIO_QC_HOLD']);
});
test('diagnostic cause depth remains bounded even for many valid admission failures',()=>{
 const e=prototypeAudioQCHold(['SOURCE_AUDIO_QC_FAILED','ENDPOINT_PROFILE_REQUIRED','ACTUAL_CUE_BYTES_REQUIRED',
  'EXACT_PARENT_CONTEXT_PCM_REQUIRED','BOUND_NATIVE_TRANSITION_QC_REQUIRED']);
 assert.equal(diagnosticReasons(e).length,5);
});
