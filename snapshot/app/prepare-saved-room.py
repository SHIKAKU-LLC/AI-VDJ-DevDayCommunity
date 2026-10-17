"""Prepare an offline24s source-contiguous catalogue; no providers or credentials."""
from pathlib import Path
import argparse,importlib.util,json,hashlib,sys,shutil
import numpy as np
import soundfile as sf
spec=importlib.util.spec_from_file_location('room_dsp',Path(__file__).parent/'runtime/dj-transition-dsp.py');dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)
sha=lambda b:hashlib.sha256(b).hexdigest()
def context(x,sr):
 import io
 import wave
 b=io.BytesIO();samples=np.clip(np.floor(x[-16*sr:]*32768+.5),-32768,32767).astype('<i2')
 with wave.open(b,'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes(samples.tobytes())
 return sha(b.getvalue())
def prepare(source,out):
 out=Path(out);reserved=['origin-verified.wav','contiguous-0.wav','contiguous-1.wav','contiguous-pair.wav','safe-fallback.wav']
 if Path(source).resolve() in [(out/n).resolve() for n in reserved]:raise ValueError('ORIGINAL_OVERWRITE_REFUSED')
 out.mkdir(parents=True,exist_ok=True);origin,sr=dsp.read_audio(source);count=24*sr
 if len(origin)<2*count:raise ValueError('ACTUAL48_SECOND_SOURCE_REQUIRED')
 origin_sha=dsp.digest_file(source);shutil.copyfile(source,out/'origin-verified.wav');parts=[]
 for i in range(2):
  path=out/f'contiguous-{i}.wav';section=origin[i*count:(i+1)*count];sf.write(path,section,sr,subtype='FLOAT');decoded,_=dsp.read_audio(path)
  if not np.array_equal(decoded,section):raise ValueError('SOURCE_SAMPLES_CHANGED')
  profile=dsp.profile(path)
  if profile['activity']['maxQuietRunSeconds']>.15 or profile['head']['rmsDbfs']<-36 or profile['loudness']['truePeakDbtp']>-.3 or profile['nonfiniteSamples'] or profile['clippedFraction']:raise ValueError('SOURCE_AUDIO_QC_FAILED')
  parts.append({'file':path.name,'profile':profile,'contextSha256':context(decoded,sr),'sourceLineage':{'method':'saved-pcm-range-v1','originSha256':origin_sha,'originFrameCount':len(origin),'startFrame':i*count,'endFrame':(i+1)*count,'pcmSha256':sha(decoded.astype('<f4').tobytes())}})
 transition={'type':'saved-contiguous','entryFrame':0,'exitFrame':count,'overlapFrames':0,'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':None}
 receipt=dsp.inspect_pair(out/parts[0]['file'],out/parts[1]['file'],transition,out/'contiguous-pair.wav')
 receipt.update({'sourceContinuityVerified':True,'sourceContinuity':{'current':parts[0]['sourceLineage'],'incoming':parts[1]['sourceLineage']},'contextSha256':parts[0]['contextSha256'],'nativeContinuationVerified':False})
 if not receipt['renderQC']['passed']:raise ValueError('ACTUAL_RENDER_QC_FAILED')
 rendered,_=dsp.read_audio(out/'contiguous-pair.wav')
 if not np.array_equal(rendered,origin[:2*count]):raise ValueError('RENDER_NOT_ORIGINAL_CONTIGUOUS_SAMPLES')
 fallback_spec={**transition,'type':'native-continuation','seamDeclickFrames':882}
 fallback=dsp.inspect_pair(out/parts[0]['file'],out/parts[0]['file'],fallback_spec,out/'safe-fallback.wav')
 if not fallback['renderQC']['passed']:raise ValueError('FALLBACK_RENDER_QC_FAILED')
 result={'fallback':{'file':'safe-fallback.wav','receipt':fallback},'method':'verified-saved-room-catalog-v1','cueSeconds':24,'parts':parts,'pair':{'file':'contiguous-pair.wav','receipt':receipt},'sourceProvenance':{'kind':'existing-QC-render-unmodified-adjacent-ranges','originSha256':origin_sha,'originFrameCount':len(origin),'actualGenerationThisRun':False,'originFile':'origin-verified.wav','originalDurationSeconds':len(origin)/sr,'newProviderNativeContinuityClaimed':False,'padding':False,'looping':False,'timeStretch':False,'pitchShift':False}}
 (out/'catalog.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'prepared':True,'sourceSha256':origin_sha,'cueSeconds':24,'sourceDurationSeconds':len(origin)/sr,'renderQC':receipt['renderQC'],'newAPIRequests':0}))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--out',required=True);args=parser.parse_args();prepare(args.source,args.out)
