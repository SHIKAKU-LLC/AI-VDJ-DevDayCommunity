# -*- coding: utf-8 -*-
"""Bind supplied human feedback to the exact heard windows and measured renders.

Requires explicit feedback input. No default approval, inference upgrade, model
calibration, new media generation, or overwrite of the comparison source.
"""
import argparse,json,hashlib,shutil,math
from pathlib import Path
import importlib.util,numpy as np,soundfile as sf
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('dsp',ROOT/'app/runtime/dj-transition-dsp.py');dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)

def normalized(v):
 if isinstance(v,dict):return {k:normalized(x) for k,x in v.items()}
 if isinstance(v,list):return [normalized(x) for x in v]
 if isinstance(v,float) and v.is_integer():return int(v)
 return v

def digest(v):return hashlib.sha256(json.dumps(normalized(v),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def prepare(feedback_path,out):
 out=Path(out)
 if out.exists():raise ValueError('NEW_REVIEWED_CACHE_REQUIRED')
 feedback_path=Path(feedback_path);feedback=json.loads(feedback_path.read_text())
 folder=ROOT/'app/connection/independent-evidence-20261013';review_path=folder/'review-final/review-request.json';review=json.loads(review_path.read_text());summary=json.loads((folder/'SUMMARY.json').read_text());delivery=json.loads((ROOT/'review/independent-evidence-20261013/LIBRARY-REVIEW.json').read_text())
 if feedback.get('method')!='trusted-user-comparison-feedback-v1' or feedback.get('status')!='accepted' or feedback.get('revoked') is not False or feedback.get('scope')!='exact-presented-transition-windows' or feedback.get('preferredLabel') is not None or feedback.get('comparisonSha256')!=dsp.digest_file(review_path) or set(feedback.get('acceptedLabels',[]))!={'A','B'} or not feedback.get('sourceMessageId','').startswith('Sentinel_') or not feedback.get('quote','').strip():raise ValueError('EXPLICIT_BOUND_USER_FEEDBACK_REQUIRED')
 base=ROOT/'app/connection/cross-track-20261013/run-02';old=json.loads((base/'evaluation.json').read_text())
 out.mkdir(parents=True);sources={}
 for name,oldname in [('current','variant-A'),('music-B','music-B'),('original-current','current'),('variant-C','variant-C')]:
  file=out/(name+'.wav');shutil.copyfile(base/old['sources'][oldname]['file'],file)
  sources[name]={'file':file.name,'profile':old['sources'][oldname]['profile'],'provenance':{'method':'unchanged-prepared-saved-recording','actualGenerationThisRun':False}}
 approvals=[];records=[]
 for item in review['choices']:
  label=item['label'];src=folder/'review-final'/('A-bass-swap-full.wav' if label=='A' else 'B-nonoverlap-cut-full.wav');file=out/('reviewed-'+label+'.wav');snippet=out/('heard-'+label+'.wav');shutil.copyfile(src,file);shutil.copyfile(folder/'review-final'/item['file'],snippet)
  r=item['fullReceipt'];a,sr=dsp.read_audio(file);heard,_=dsp.read_audio(snippet)
  if dsp.digest_file(file)!=r['renderedSha256'] or dsp.digest_file(snippet)!=item['sha256'] or not np.array_equal(a[item['sampleStartFrameInRender']:item['sampleStartFrameInRender']+len(heard)],heard):raise ValueError('HEARD_WINDOW_CHANGED')
  if r['renderQC']['passed'] is not True:raise ValueError('OBJECTIVE_QC_STILL_REQUIRED')
  if label=='B':
   r={**r,'method':'rendered-transition-qc-v1','passed':True,'currentPlaybackRevision':0,'currentFrameCount':24*sr,'incomingFrameCount':24*sr,'sampleRate':sr,'type':'reviewed-nonoverlap-cut','relativeIncomingGainDb':0,'eqCurves':None,'seamDeclickFrames':r['edgeTaperFramesPerSide']*2,'bassCollisionManaged':True,'loudnessVerified':True,'nativeContinuationVerified':False,'beatGridVerified':False,'downbeatVerified':False,'phraseVerified':False}
  spec={k:r[k] for k in ['type','entryFrame','exitFrame','overlapFrames','sampleRate','relativeIncomingGainDb','eqCurves']}
  if 'seamDeclickFrames' in r:spec['seamDeclickFrames']=r['seamDeclickFrames']
  r['renderSpecSha256']=digest(spec)
  library=next(x for x in delivery['files'] if x['label']==label)
  if library['localSha256']!=item['sha256'] or not library['nativeReadConfirmed']:raise ValueError('PRESENTED_LIBRARY_IDENTITY_REQUIRED')
  approved={'variantLabel':label,'currentSha256':r['currentSha256'],'incomingSha256':r['incomingSha256'],'renderedSha256':r['renderedSha256'],'renderSpecSha256':r['renderSpecSha256'],'snippetSha256':item['sha256'],'snippetPcmSha256':hashlib.sha256(heard.astype('<f4').tobytes()).hexdigest(),'snippetStartFrame':item['sampleStartFrameInRender'],'snippetFrameCount':len(heard),'libraryFileId':library['library_file_id'],'fileId':library['file_id']}
  approvals.append(approved);records.append({'incoming':'music-B','variantLabel':label,'file':file.name,'snippetFile':snippet.name,'receipt':r,'approved':approved})
 feedback={**feedback,'approvals':approvals};feedback['feedbackSha256']=digest(feedback)
 for record in records:
  r=record['receipt'];phase={'method':'cross-method-local-phase-v1','currentSha256':r['currentSha256'],'incomingSha256':r['incomingSha256'],'periodSeconds':review['phaseChecks'][0]['existingPolicyToleranceSeconds']/.08,'checks':review['phaseChecks'],'longContextMaxErrorSeconds':summary['confidence']['beatPhase']['longContextMaxErrorSeconds'],'calibrated':False}
  bound={'method':'exact-user-reviewed-join-v1','feedback':feedback,**record.pop('approved'),'phase':phase};bound['receiptSha256']=digest(bound);r['reviewedTransition']=bound
 fallback=dsp.inspect_pair(out/'current.wav',out/'current.wav',{'type':'native-continuation','entryFrame':0,'exitFrame':24*44100,'overlapFrames':0,'sampleRate':44100,'relativeIncomingGainDb':0,'eqCurves':None,'seamDeclickFrames':882},out/'fallback.wav')
 if not fallback['renderQC']['passed']:raise ValueError('FALLBACK_QC_REQUIRED')
 catalog={'method':'user-reviewed-independent-cache-v1','sources':sources,'incomingNames':['music-B','original-current','variant-C'],'pairs':records,'feedback':feedback,'feedbackInputSha256':dsp.digest_file(feedback_path),'fallback':{'file':'fallback.wav','receipt':fallback},'actualAPIRequests':0,'generalIndependentMixingVerified':False}
 (out/'catalog.json').write_text(json.dumps(normalized(catalog),ensure_ascii=False,indent=2)+'\n');print(json.dumps({'variants':[r['variantLabel'] for r in records],'preferredLabel':None,'feedbackSha256':feedback['feedbackSha256']}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--feedback',required=True);p.add_argument('--out',required=True);a=p.parse_args();prepare(a.feedback,a.out)
