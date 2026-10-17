"""Cross-method evidence for independent edits. Never emits an adoption receipt.

No inference confidence is equated with a calibrated correctness probability.
BeatThis perturbations measure repeatability; librosa DP is a separate method.
CQT/HPSS tonal hypotheses and multi-scale novelty retain competing explanations.
"""
import os
os.environ.setdefault('NUMBA_CACHE_DIR', '/tmp/vdj-independent-numba')
import argparse, importlib.util, json, hashlib
from pathlib import Path
import numpy as np, soundfile as sf, librosa
from scipy import signal
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('features',ROOT/'app/runtime/musical-features.py');features=importlib.util.module_from_spec(spec);spec.loader.exec_module(features)
SR=22050;HOP=256
TEMPERLEY={'major':[5,2,3.5,2,4.5,4,2,4.5,2,3.5,1.5,4], 'minor':[5,2,3.5,4.5,2,4,2,4.5,3.5,2,1.5,4]}

def key_ranking(chroma, templates):
 c=chroma-chroma.mean();rows=[]
 for mode,template in templates.items():
  for tonic in range(12):
   t=np.roll(template,tonic);rows.append({'tonic':features.KEYS[tonic],'mode':mode,'correlation':features.cosine(c,t-t.mean())})
 return sorted(rows,key=lambda r:-r['correlation'])[:4]

def agreement(reference, observed, tolerance=.035):
 a=np.asarray(reference);b=np.asarray(observed)
 if not len(a) or not len(b):return {'referenceCoverage':0.,'observationPrecision':0.,'medianErrorSeconds':None,'p95ErrorSeconds':None}
 d=np.min(abs(a[:,None]-b[None,:]),axis=1);r=np.min(abs(b[:,None]-a[None,:]),axis=1)
 return {'referenceCoverage':float(np.mean(d<=tolerance)),'observationPrecision':float(np.mean(r<=tolerance)),'medianErrorSeconds':float(np.median(d)),'p95ErrorSeconds':float(np.percentile(d,95)),'toleranceSeconds':tolerance}

def novelty(data,half):
 f=np.asarray(data,dtype=float)
 if not np.isfinite(f).all():raise ValueError('NONFINITE_STRUCTURAL_FEATURE')
 scale=np.max(abs(f),axis=0,keepdims=True);f=f/np.maximum(scale,1e-300)
 norm=np.sqrt(np.einsum('ij,ij->j',f,f))[None,:];f=f/np.maximum(norm,1e-300)
 S=np.einsum('it,iu->tu',f,f,optimize=False);n=S.shape[0];out=np.full(n,np.nan)
 for i in range(half,n-half):
  aa=S[i-half:i,i-half:i].mean();bb=S[i:i+half,i:i+half].mean();ab=S[i-half:i,i:i+half].mean()
  out[i]=max(0.,float((aa+bb)/2-ab))
 return out

def sync(data,times,beats):
 values=[]
 for a,b in zip(beats[:-1],beats[1:]):
  mask=(times>=a)&(times<b);values.append(np.mean(data[:,mask],axis=1) if mask.any() else np.zeros(data.shape[0]))
 return np.asarray(values).T

def analyze(path,model,repeatability=True):
 if Path(path).suffix=='.pcm':x,rate=sf.read(path,format='RAW',subtype='PCM_16',samplerate=44100,channels=2,always_2d=True,dtype='float32')
 else:x,rate=sf.read(path,always_2d=True,dtype='float32')
 asset=features.sha_file(path)
 if rate!=44100 or x.shape[1]!=2:raise ValueError('NATIVE_STEREO_REQUIRED')
 tracker,post=model;versions=[]
 views=[('original',x,0)]
 if repeatability:views += [('gain-minus6db',x*.5,0),('crop137ms',x[round(.137*rate):],round(.137*rate)/rate)]
 for label,data,offset in views:
  beat_logits,down_logits=tracker(data,rate);b,d=post(beat_logits,down_logits)
  versions.append({'condition':label,'beatSeconds':(np.asarray(b)+offset).tolist(),'downbeatSeconds':(np.asarray(d)+offset).tolist(),'fit':features.fit_beats(np.asarray(b)+offset)})
 block=4410;levels=np.array([np.sqrt(np.mean(x[i:i+block].astype(float)**2)) for i in range(0,len(x),block)]);active=np.flatnonzero(levels>=10**(-45/20))
 activity={'windowSeconds':.1,'rawThresholdDbfs':-45,'activeFraction':float(len(active)/len(levels)),'lastActiveSeconds':float(min(len(x)/rate,(active[-1]+1)*.1)) if len(active) else None,'silenceUsedAsPhraseEvidence':False}
 beats=np.asarray(versions[0]['beatSeconds']);downs=np.asarray(versions[0]['downbeatSeconds'])
 for v in versions[1:]:
  reference=beats[(beats>=.8)&(beats<=len(x)/rate-.8)];reference_d=downs[(downs>=.8)&(downs<=len(x)/rate-.8)]
  v['beatAgreement']=agreement(reference,[b for b in v['beatSeconds'] if .8<=b<=len(x)/rate-.8])
  v['downbeatAgreement']=agreement(reference_d,[d for d in v['downbeatSeconds'] if .8<=d<=len(x)/rate-.8])
 # Choose the higher-energy single channel for algorithms requiring mono. No
 # stereo downmix cancellation; this choice and ratio are recorded.
 powers=np.mean(x.astype(float)**2,axis=0);channel=int(np.argmax(powers));y=librosa.resample(x[:,channel],orig_sr=rate,target_sr=SR)
 D=librosa.stft(y,n_fft=2048,hop_length=HOP);H,P=librosa.decompose.hpss(D,margin=3)
 harmonic=librosa.istft(H,hop_length=HOP,length=len(y));percussive=librosa.istft(P,hop_length=HOP,length=len(y))
 dp=[]
 for name,wave in [('full',y),('percussive',percussive)]:
  onsets=librosa.onset.onset_strength(y=wave,sr=SR,hop_length=HOP)
  for start_bpm in [70,120,180]:
   tempo,b=librosa.beat.beat_track(onset_envelope=onsets,sr=SR,hop_length=HOP,start_bpm=start_bpm,trim=False)
   seconds=librosa.frames_to_time(b,sr=SR,hop_length=HOP)
   dp.append({'input':name,'startBpmPrior':start_bpm,'estimatedBpm':float(np.asarray(tempo).ravel()[0]),'beatSeconds':seconds.tolist(),'fit':features.fit_beats(seconds),'agreementWithNeural':agreement(beats,seconds)})
 tune=float(librosa.estimate_tuning(y=harmonic,sr=SR,n_fft=8192,fmin=100,fmax=3000))
 C=np.abs(librosa.cqt(harmonic,sr=SR,hop_length=HOP,fmin=librosa.note_to_hz('C2'),n_bins=72*3,bins_per_octave=36,tuning=tune*3))
 chroma=librosa.feature.chroma_cqt(C=C,sr=SR,hop_length=HOP,bins_per_octave=36,n_octaves=6,norm=None)
 times=librosa.times_like(chroma,sr=SR,hop_length=HOP)
 def tonal(start,end):
  mask=(times>=start)&(times<end);v=chroma[:,mask].mean(axis=1);v=v/max(v.sum(),1e-15)
  return {'startSeconds':float(start),'endSeconds':float(end),'pitchClassMass':v.tolist(),'krumhansl':key_ranking(v,features.TEMPLATES),'temperley':key_ranking(v,TEMPERLEY)}
 windows=[tonal(t,t+2) for t in np.arange(0,len(x)/rate-1.99,2)]
 full=tonal(0,len(x)/rate)
 mfcc=librosa.feature.mfcc(y=y,sr=SR,hop_length=HOP,n_mfcc=13)[1:]
 mfcc=(mfcc-mfcc.mean(axis=1,keepdims=True))/(mfcc.std(axis=1,keepdims=True)+1e-9)
 mtime=librosa.times_like(mfcc,sr=SR,hop_length=HOP)
 cf=sync(chroma,times,beats);mf=sync(mfcc,mtime,beats)
 structure=[]
 for name,data in [('chroma',cf),('timbre',mf)]:
  for half in ([4,8,16] if len(beats)>40 else [4,8]):
   n=novelty(data,half);valid=np.flatnonzero(np.isfinite(n));values=n[valid]
   peaks,_=signal.find_peaks(np.nan_to_num(n),distance=4)
   rows=[{'beatIndex':int(i),'seconds':float(beats[i]),'novelty':float(n[i]),'percentileWithinClip':float(np.mean(values<=n[i]))} for i in peaks if np.isfinite(n[i])]
   structure.append({'feature':name,'halfWindowBeats':half,'validBoundaryCount':len(valid),'peaks':sorted(rows,key=lambda r:-r['novelty'])[:6]})
 # Metrical accent is only a diagnostic: no forced winner when four phases have
 # similar contrast. It is deliberately not promoted to a downbeat annotation.
 band=abs(D[:16])**2;bt=librosa.times_like(D,sr=SR,hop_length=HOP);low=sync(band,bt,beats).mean(axis=0)
 accents=[float(np.mean(low[np.arange(len(low))%4==k])) for k in range(4)]
 return {'method':'independent-musical-evidence-v1','assetSha256':asset,'pcmSha256':hashlib.sha256(x.astype('<f4').tobytes()).hexdigest(),'durationSeconds':len(x)/rate,'monoAnalysisChannel':channel,'channelPowerRatio':float(max(powers)/max(min(powers),1e-15)), 'activity':activity,'beatThisRepeatability':versions,'independentDynamicProgramming':dp,'tonal':{'method':'HPSS-harmonic-CQT72semitones-36binsPerOctave','estimatedTuningSemitones':tune,'global':full,'windows':windows,'keyVerified':False},'structure':{'method':'beat-synchronous-multiscale-self-similarity-novelty','curves':structure,'lowBandAccentByModulo4Beat':accents,'phraseVerified':False,'annotationAvailable':False},'confidence':{'kind':'cross-method-evidence-and-repeatability','calibratedCorrectnessProbability':None,'automaticAdoption':False},'privateAudioUploaded':False}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--catalog',required=True);p.add_argument('--checkpoint',required=True);p.add_argument('--out',required=True);p.add_argument('--full-context',action='store_true');a=p.parse_args()
 out=Path(a.out)
 if out.exists():raise ValueError('NEW_OUTPUT_REQUIRED')
 catalog=Path(a.catalog).resolve();d=json.loads(catalog.read_text());model,info=features.load_model(a.checkpoint);rows={}
 for name,v in d['sources'].items():
  print('analyzing',name,flush=True);rows[name]=analyze(catalog.parent/v['file'],model,repeatability=not a.full_context);print(name,[(r['input'],r['startBpmPrior'],round(r['estimatedBpm'],2),round(r['agreementWithNeural']['referenceCoverage'],2)) for r in rows[name]['independentDynamicProgramming']],flush=True)
 result={'method':'independent-evidence-suite-v1','extractorSha256':features.sha_file(__file__),'model':info,'sourceCatalogSha256':features.sha_file(catalog),'sources':rows,'actualAPIRequests':0,'subjectiveListeningVerified':False}
 out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
