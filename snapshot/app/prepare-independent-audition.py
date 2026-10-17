# -*- coding: utf-8 -*-
"""Small honest A/B listening request for the same independent-source boundary.

A = inspected bass swap. B = no simultaneous sources, short edge tapers.
Both remain HOLD. A short cut is not called atonal or automatically good.
"""
import os
os.environ.setdefault('NUMBA_CACHE_DIR','/tmp/vdj-independent-numba')
from pathlib import Path
import argparse,importlib.util,json,hashlib
import numpy as np,soundfile as sf
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('dsp',ROOT/'app/runtime/dj-transition-dsp.py');dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)

def nonoverlap(a,b,exit_frame,entry_frame,taper):
 if not np.isfinite(a).all() or not np.isfinite(b).all():raise ValueError('NONFINITE_PCM')
 if not (0<exit_frame<=len(a) and 0<=entry_frame<len(b) and 2<=taper<=441):raise ValueError('SHORT_NATIVE_EDGE_TAPER_REQUIRED')
 if exit_frame<taper or len(b)-entry_frame<taper:raise ValueError('TAPER_EXCEEDS_SOURCE')
 out=np.concatenate([a[:exit_frame].copy(),b[entry_frame:].copy()])
 out[exit_frame-taper:exit_frame]*=np.cos(np.linspace(0,np.pi/2,taper))[:,None]
 out[exit_frame:exit_frame+taper]*=np.sin(np.linspace(0,np.pi/2,taper))[:,None]
 return out

def local_tonal(x,sr,start,end):
 import librosa
 channel=int(np.argmax(np.mean(x*x,axis=0)));y=librosa.resample(x[:,channel],orig_sr=sr,target_sr=22050)
 D=librosa.stft(y,n_fft=2048,hop_length=256);H,P=librosa.decompose.hpss(D,margin=3)
 harmonic=librosa.istft(H,hop_length=256,length=len(y));tune=float(librosa.estimate_tuning(y=harmonic,sr=22050,n_fft=8192,fmin=100,fmax=3000))
 C=abs(librosa.cqt(harmonic,sr=22050,hop_length=256,fmin=librosa.note_to_hz('C2'),n_bins=216,bins_per_octave=36,tuning=tune*3))
 cq=librosa.feature.chroma_cqt(C=C,sr=22050,hop_length=256,bins_per_octave=36,n_octaves=6,norm=None)
 st=librosa.feature.chroma_stft(S=abs(H)**2,sr=22050,hop_length=256,n_fft=2048)
 vectors={}
 for name,data in [('cqt',cq),('stft',st)]:
  times=librosa.times_like(data,sr=22050,hop_length=256);mask=(times>=start)&(times<end);v=data[:,mask].mean(axis=1);vectors[name]=(v/max(float(v.sum()),1e-15)).tolist()
 times=librosa.times_like(D,sr=22050,hop_length=256);mask=(times>=start)&(times<end)
 return {'sourceWindowSeconds':[start,end],'pitchClassMass':vectors,'harmonicEnergyFraction':float(np.sum(abs(H[:,mask])**2)/max(np.sum(abs(D[:,mask])**2),1e-15)),'tuningSemitonesEstimate':tune,'harmonicSafetyVerified':False}


def phase_checks(outgoing,incoming,exit_s,entry_s,half,period):
 rows=[]
 for kind in ['original','gain-minus6db','crop137ms','dp-full','dp-percussive']:
  def times(row):
   if kind.startswith('dp-'):return next(v['beatSeconds'] for v in row['independentDynamicProgramming'] if v['input']==kind[3:] and v['startBpmPrior']==120)
   return next(v['beatSeconds'] for v in row['beatThisRepeatability'] if v['condition']==kind)
  available_start=round(.137*44100)/44100 if kind=='crop137ms' else 0
  left=max(exit_s-half,available_start,exit_s-entry_s+available_start);right=exit_s+half
  a=np.asarray(times(outgoing));b=np.asarray(times(incoming));a=a[(a>=left)&(a<=right)];b=b+exit_s-entry_s
  err=np.min(abs(a[:,None]-b[None,:]),axis=1) if len(a) and len(b) else np.array([1.])
  rows.append({'method':kind,'currentBeatCount':len(a),'testedWindowStart':left,'fullWindowCovered':left<=exit_s-half,'maximumRelativeErrorSeconds':float(err.max()),'medianRelativeErrorSeconds':float(np.median(err)),'existingPolicyToleranceSeconds':.08*period,'withinExistingPhaseTolerance':bool(np.all(err<=.08*period))})
 return rows


def build(root,out):
 root=Path(root);out=Path(out)
 if out.exists():raise ValueError('NEW_OUTPUT_REQUIRED')
 catalog=root/'app/connection/cross-track-20261013/run-02'
 evidence_path=root/'app/connection/independent-evidence-20261013/evidence.json';evidence=json.loads(evidence_path.read_text())
 outgoing=evidence['sources']['variant-A'];incoming_evidence=evidence['sources']['music-B']
 period=(outgoing['beatThisRepeatability'][0]['fit']['periodSeconds']+incoming_evidence['beatThisRepeatability'][0]['fit']['periodSeconds'])/2
 chroma_peaks=next(c['peaks'] for c in outgoing['structure']['curves'] if c['feature']=='chroma' and c['halfWindowBeats']==4)
 timbre_peaks=next(c['peaks'] for c in outgoing['structure']['curves'] if c['feature']=='timbre' and c['halfWindowBeats']==4)
 supported=[c for c in chroma_peaks if c['seconds']>=8 and c['seconds']<=22 and any(abs(c['seconds']-t['seconds'])<=period/2 for t in timbre_peaks)]
 if not supported:raise ValueError('NO_CROSS_FEATURE_OUTGOING_BOUNDARY')
 exit_seconds=max(supported,key=lambda c:c['novelty'])['seconds'];overlap_frames=2*round(period*4*44100/2)
 half=overlap_frames/88200
 entries=[t for t in incoming_evidence['beatThisRepeatability'][0]['downbeatSeconds'] if t>=half+.8 and t+half<=10]
 if not entries:raise ValueError('NO_BOUNDED_INCOMING_DOWNBEAT')
 def vector_at(source,t):
  values=[];weights=[]
  for w in source['tonal']['windows']:
   overlap=max(0,min(w['endSeconds'],t+half)-max(w['startSeconds'],t-half))
   if overlap:values.append(w['pitchClassMass']);weights.append(overlap)
  return np.average(values,axis=0,weights=weights)
 av=vector_at(outgoing,exit_seconds)
 def local_similarity(t):
  bv=vector_at(incoming_evidence,t);return float(np.dot(av,bv)/(np.linalg.norm(av)*np.linalg.norm(bv)))
 entry_seconds=max(entries,key=local_similarity)
 r={'entryFrame':round(entry_seconds*44100),'exitFrame':round(exit_seconds*44100)}
 specification={'type':'bass-swap',**r,'overlapFrames':overlap_frames,'sampleRate':44100,'relativeIncomingGainDb':0,'eqCurves':dsp.bass_curves(overlap_frames,44100)}
 current=catalog/'variant-A-24.wav';incoming=catalog/'music-B-24.wav';before={str(f):dsp.digest_file(f) for f in [current,incoming]}
 if before[str(current)]!=outgoing['assetSha256'] or before[str(incoming)]!=incoming_evidence['assetSha256']:raise ValueError('STALE_FEATURE_SOURCE')
 a,sr=dsp.read_audio(current);b,_=dsp.read_audio(incoming);out.mkdir(parents=True)
 half=overlap_frames/(2*sr);tonal_a=local_tonal(a,sr,exit_seconds-half,exit_seconds+half);tonal_b=local_tonal(b,sr,entry_seconds-half,entry_seconds+half)
 checks=phase_checks(outgoing,incoming_evidence,exit_seconds,entry_seconds,half,period)
 cosines={}
 for method in ['cqt','stft']:
  av=np.asarray(tonal_a['pitchClassMass'][method]);bv=np.asarray(tonal_b['pitchClassMass'][method]);cosines[method]=float(np.dot(av,bv)/max(np.linalg.norm(av)*np.linalg.norm(bv),1e-15))
 A=dsp.inspect_pair(current,incoming,specification,out/'A-bass-swap-full.wav');xA,_=dsp.read_audio(out/'A-bass-swap-full.wav')
 taper=round(.004*sr);xB=nonoverlap(a,b,r['exitFrame'],r['entryFrame'],taper)
 sf.write(out/'B-nonoverlap-cut-full.wav',xB,sr,subtype='FLOAT');xB,_=dsp.read_audio(out/'B-nonoverlap-cut-full.wav')
 mB=dsp.render_metrics(xB,sr,r['exitFrame'],0);mB['overlapLowBandLiftDb']=0.
 B={'method':'review-only-nonoverlap-cut-v1','currentSha256':before[str(current)],'incomingSha256':before[str(incoming)],'entryFrame':r['entryFrame'],'exitFrame':r['exitFrame'],'overlapFrames':0,'edgeTaperFramesPerSide':taper,'edgeTaperSecondsPerSide':taper/sr,'renderedFrameCount':len(xB),'renderedSha256':dsp.digest_file(out/'B-nonoverlap-cut-full.wav'),'renderMetrics':mB,'renderQC':{'passed':not dsp.qc_reasons(mB),'reasons':dsp.qc_reasons(mB)},'timeStretch':False,'pitchShift':False,'atonalSourceClaim':False}
 start=r['exitFrame']-5*sr;end=r['exitFrame']+5*sr;rows=[]
 if start<0 or end>min(len(xA),len(xB)):raise ValueError('TEN_SECOND_LISTENING_WINDOW_UNAVAILABLE')
 for label,x,receipt in [('A',xA,A),('B',xB,B)]:
  file=out/(label+'-listen-10s.wav');sf.write(file,x[start:end],sr,subtype='FLOAT')
  rows.append({'label':label,'file':file.name,'sha256':dsp.digest_file(file),'seconds':10,'transitionAtSeconds':5,'sampleStartFrameInRender':start,'renderedSha256':receipt['renderedSha256'],'automaticEligibility':'HOLD','objectiveAudioQC':receipt['renderQC'],'fullReceipt':receipt})
 after={str(f):dsp.digest_file(f) for f in [current,incoming]}
 if after!=before:raise ValueError('ORIGINAL_CHANGED')
 result={'method':'independent-listening-request-v1','builderSha256':dsp.digest_file(__file__),'sourcePair':'variant-A-to-music-B; no exact shared-PCM exemption','selection':{'outgoing':'strongest chroma novelty peak also supported by timbre within half a beat','incoming':'interior observed downbeat with highest local CQT similarity in the pre-change region; phrase identity remains unverified','exitSeconds':exit_seconds,'entrySeconds':entry_seconds,'analysisSha256':dsp.digest_file(evidence_path)},'phaseChecks':checks,'localTonalEvidence':{'outgoing':tonal_a,'incoming':tonal_b,'cosineByMethod':cosines,'warning':'similarity is not calibrated harmonic acceptance'},'choices':rows,'questions':['A/Bのどちらか、または両方不可か。','5秒付近で拍が二重・ずれる、低音が落ちる、耳につく音程のぶつかりがあるか。','5秒付近が曲の途中を不自然に切ったように聞こえるか。'],'scope':'Only these exact source and render SHAs; not a general independent-DJ calibration','humanReview':None,'automaticAdoption':False,'actualAPIRequests':0,'sourceHashesBefore':before,'sourceHashesAfter':after,'allOriginalsPreserved':True}
 (out/'review-request.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
 (out/'index.html').write_text('''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>独立接続 10秒 A/B</title><style>body{max-width:780px;margin:48px auto;background:#111a1a;color:#eff4ee;font:17px/1.7 system-ui;padding:20px}article{padding:24px;border:1px solid #4d655b;border-radius:12px;margin:22px 0}audio{width:100%}small{color:#bcc9bf}h1{font-size:26px}h2{font-size:20px}b{color:#d9f090}</style><h1>独立した保存音源の接続を確認</h1><p>保存素材A → Music B。どちらも10秒。<b>5秒付近が切替の中心</b>です。音声の測定QCは実施済みですが、音楽としての採用は保留中です。</p><article><h2>A — 低音を入れ替える約1.65秒の重なり</h2><audio controls preload="metadata" src="A-listen-10s.wav"></audio></article><article><h2>B — 2曲を同時に鳴らさない短い切替</h2><audio controls preload="metadata" src="B-listen-10s.wav"></audio><small>境界の前後各4msだけ音量をなめらかにします。非調性的な音源という意味ではありません。</small></article><p>確認：①A/B/両方不可　②拍のずれ・低音の抜け・音程のぶつかり　③フレーズ途中の不自然な切断。</p><p><small>判断はこの音源・接続だけに適用します。回答前に自動採用や参加者creditを発行しません。</small></p></html>''')
 print(json.dumps({'choices':[{'label':x['label'],'qc':x['objectiveAudioQC'],'sha256':x['sha256']} for x in rows]},ensure_ascii=False))

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',default=str(ROOT));p.add_argument('--out',required=True);a=p.parse_args();build(a.root,a.out)
