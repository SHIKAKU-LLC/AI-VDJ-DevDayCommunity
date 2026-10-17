"""Offline cross-recording objective render comparison; no calibrated music-QA claims."""
from pathlib import Path
import argparse,importlib.util,json,hashlib,shutil
import numpy as np
import soundfile as sf
spec=importlib.util.spec_from_file_location('dsp',Path(__file__).parent/'runtime/dj-transition-dsp.py');dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)
ROOT=Path(__file__).resolve().parent.parent

def compare(out, material_set='returned'):
 out=Path(out);out.mkdir(parents=True,exist_ok=True)
 if (out/'evaluation.json').exists():raise ValueError('EXISTING_COMPARISON_PRESERVED_USE_NEW_OUTPUT')
 paths={
 'current':(ROOT/'app/connection/actual-room-20261013/contiguous-0.wav',0,24),
 'music-B':(ROOT/'vnext/eye-review/current-B-dj-24s.wav',0,24),
 'variant-A':(ROOT/'vnext/live/runtime/live-abc-03/A/result-01-original.wav',8,32),
 'variant-C':(ROOT/'vnext/live/runtime/live-abc-03/C/result-01-original.wav',8,32),
 }
 if material_set=='rendered-stream':
  for name,variant in [('variant-A','A'),('variant-C','C')]:
   paths[name]=(ROOT/f'vnext/live/runtime/live-abc-03/{variant}/rendered-stream.pcm',8,32)
 sources={};preserved={}
 for name,(path,start,end) in paths.items():
  preserved[name]=dsp.digest_file(path)
  decoded=path
  if path.suffix=='.pcm':
   # Encoding verified against vnext/live/dsp-worker.py render() writer.
   raw=np.frombuffer(path.read_bytes(),dtype='<i2')
   if raw.size%2:raise ValueError('STEREO_PCM_REQUIRED')
   original=raw.reshape(-1,2)/32768.;sr=44100
   decoded=out/f'{name}-decoded-origin.wav';sf.write(decoded,original,sr,subtype='FLOAT')
  else:original,sr=dsp.read_audio(path)
  if len(original)<end*sr:raise ValueError('ACTUAL24_SOURCE_RANGE_UNAVAILABLE')
  target=out/f'{name}-24.wav'
  if name=='current':
   shutil.copyfile(path,target);prep={'method':'unchanged-existing-current-copy','sourceSha256':preserved[name],'normalizationApplied':False}
  else:prep=dsp.prepare_headroom(decoded,target,start_frame=start*sr,end_frame=end*sr)
  p=dsp.profile(target);sources[name]={'file':target.name,'profile':p,'preparation':prep,'sourceOriginSha256':preserved[name],'sourceStartSeconds':start,'sourceEndSeconds':end,'actualNewGeneration':False,'musicalQA':{'key':'unknown','phrase':'unverified','beatConfidenceCalibrated':False}}
  print(name,p['loudness'],p['activity'],flush=True)
 pairs=[];current=out/sources['current']['file'];a,sr=dsp.read_audio(current)
 for name in ['music-B','variant-A','variant-C']:
  b,_=dsp.read_audio(out/sources[name]['file'])
  for bars in [1,2,4]:
   n=round(bars*4*60/145*sr);n+=n%2
   for kind in ['equal-power-baseline','bass-swap']:
    spec={'type':kind,'entryFrame':n//2,'exitFrame':len(a)-n//2,'overlapFrames':n,'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':dsp.bass_curves(n,sr) if kind=='bass-swap' else None}
    label=f'current-to-{name}-{bars}bars-{kind}';file=out/(label+'.wav');r=dsp.inspect_pair(current,out/sources[name]['file'],spec,file)
    pairs.append({'incoming':name,'plannedBars':bars,'assumedPlanningBpm':145,'tempoVerified':False,'file':file.name,'receipt':r})
    print(label,r['renderQC']['reasons'],flush=True)
 after={name:dsp.digest_file(path) for name,(path,_,_) in paths.items()}
 if after!=preserved:raise ValueError('ORIGINAL_MODIFIED')
 result={'method':'saved-cross-recording-review-v1','materialSet':material_set,'scope':'distinct saved recordings sharing conditioning context; not new tracks or hosted/player success','sources':sources,'pairs':pairs,'sourceHashesBefore':preserved,'sourceHashesAfter':after,'allOriginalsPreserved':True,'actualAPIRequests':0,'qualityThresholdsChanged':False,'musicalConfidencePromoted':False,'subjectiveListeningVerified':False}
 (out/'evaluation.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--out',required=True);parser.add_argument('--material-set',choices=['returned','rendered-stream'],default='returned');args=parser.parse_args();compare(args.out,args.material_set)
