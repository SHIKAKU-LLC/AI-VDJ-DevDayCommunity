import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeQcOptions,createLaunchBootstrapPreparer} from './native-qc-options.mjs';
import {syntheticWave} from '../../tests/cloud-worker-fixture.mjs';

test('native launch admits only its four explicit QC tools and preserves absent defaults',()=>{
 assert.deepEqual(readNativeQcOptions({}),{});
 const options=readNativeQcOptions({VDJ_QC_PYTHON:'python3',VDJ_QC_DSP:'snapshot/app/runtime/dj-transition-dsp.py',
  VDJ_QC_FFMPEG:'ffmpeg',VDJ_QC_FFPROBE:'ffprobe',timeoutMs:1,credential:'example_ignored'});
 assert.deepEqual(options,{python:'python3',dspModule:'snapshot/app/runtime/dj-transition-dsp.py',ffmpeg:'ffmpeg',ffprobe:'ffprobe'});
 assert(Object.isFrozen(options));
 for(const value of ['',undefined,1,'ffmpeg\nother','ffmpeg\0other'])
  assert.throws(()=>readNativeQcOptions({VDJ_QC_FFMPEG:value}),/TRUSTED_RUNTIME_PATHS_REQUIRED/);
});

test('local bootstrap lazily uses the same trusted tool configuration and closes it once',async()=>{
 let loaded=0,closed=0,seen;
 const options=readNativeQcOptions({VDJ_QC_PYTHON:'python3',VDJ_QC_FFMPEG:'ffmpeg'});
 const preparer=createLaunchBootstrapPreparer({options,createRuntime:async value=>{
  loaded++;seen=value;return {inspectBootstrap:async()=>{throw Error('SYNTHETIC_MEASUREMENT_HOLD');},
   close:async()=>{closed++;}};}});
 assert.equal(loaded,0);
 const input={audioBytes:syntheticWave(24),referenceBytes:Buffer.from([137,80,78,71,13,10,26,10])};
 await assert.rejects(preparer.prepare(input),/SYNTHETIC_MEASUREMENT_HOLD/);
 await assert.rejects(preparer.prepare(input),/SYNTHETIC_MEASUREMENT_HOLD/);
 assert.equal(loaded,1);assert.equal(seen,options);
 await preparer.close();await preparer.close();assert.equal(closed,1);
 await assert.rejects(preparer.prepare(input),/NATIVE_BOOTSTRAP_CLOSED/);
 assert.equal(loaded,1);
});

test('configured native bootstrap measures synthetic bytes and rejects unavailable configured FFmpeg',
 {skip:!process.env.VDJ_QC_PYTHON||!process.env.VDJ_QC_DSP},async t=>{
 const options=readNativeQcOptions(process.env),good=createLaunchBootstrapPreparer({options});
 t.after(()=>good.close());
 const input={audioBytes:syntheticWave(24),referenceBytes:Buffer.from([137,80,78,71,13,10,26,10])};
 const prepared=await good.prepare(input);
 assert.equal(prepared.source.music.profile.frameCount,24*44100);
 assert.equal(prepared.provenance.actualGenerationThisRun,false);
 const bad=createLaunchBootstrapPreparer({options:{...options,ffmpeg:'example_missing_qc_ffmpeg'}});
 t.after(()=>bad.close());
 await assert.rejects(bad.prepare(input),/BOOTSTRAP_MEASUREMENT_FAILED/);
});
