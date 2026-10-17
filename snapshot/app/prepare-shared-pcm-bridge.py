"""Create an explicit, non-destructive saved branch-switch demonstration.

Two generated recordings share conditioning audio. They are not two independent
songs. A common attenuation makes the shared float PCM exactly equal; discovery
uses byte equality, not a similarity score, BPM/key estimate or desired outcome.
"""
from pathlib import Path
import argparse, importlib.util, hashlib, json, shutil
import numpy as np
import soundfile as sf
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('dsp',ROOT/'app/runtime/dj-transition-dsp.py')
dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)


def shared_range(a,b,sr):
    # Bounded exact search at 500ms starts. This can miss an unaligned match but
    # cannot promote a partial/similar match. Expand a matching seed per sample.
    block=sr//2
    index={hashlib.sha256(b[j:j+block].astype('<f4').tobytes()).digest():j for j in range(0,len(b)-block+1,block)}
    best=None;seen_offsets=set()
    for i in range(0,len(a)-block+1,block):
        j=index.get(hashlib.sha256(a[i:i+block].astype('<f4').tobytes()).digest())
        if j is None or not np.array_equal(a[i:i+block],b[j:j+block]):continue
        offset=j-i
        if offset in seen_offsets:continue
        seen_offsets.add(offset)
        lo=max(0,-offset);hi=min(len(a),len(b)-offset)
        equal=np.all(a[lo:hi]==b[lo+offset:hi+offset],axis=1)
        edges=np.diff(np.r_[False,equal,False].astype(int))
        starts=np.flatnonzero(edges==1);ends=np.flatnonzero(edges==-1)
        if len(starts):
            longest=int(np.argmax(ends-starts));start=int(starts[longest]);end=int(ends[longest])
            if best is None or end-start>best[2]:best=(start+lo,start+lo+offset,end-start)
    return best


def prepare(out):
    out=Path(out)
    if out.exists():raise ValueError('NEW_OUTPUT_DIRECTORY_REQUIRED')
    out.mkdir(parents=True)
    base=ROOT/'app/connection/cross-track-20261013/run-02'
    before={n:dsp.digest_file(base/n) for n in ['variant-A-24.wav','variant-C-decoded-origin.wav','current-24.wav','music-B-24.wav']}
    a_file=out/'shared-current-a.wav';shutil.copyfile(base/'variant-A-24.wav',a_file)
    c_file=out/'shared-incoming-c.wav'
    prior=json.loads((base/'evaluation.json').read_text())
    gain=prior['sources']['variant-A']['preparation']['gainDb']
    prep=dsp.prepare_headroom(base/'variant-C-decoded-origin.wav',c_file,start_frame=8*44100,end_frame=32*44100,gain_db=gain)
    a,sr=dsp.read_audio(a_file);b,_=dsp.read_audio(c_file)
    match=shared_range(a,b,sr)
    if match is None or match[2]<4*sr:raise ValueError('NO_ACTIVE_FOUR_SECOND_EXACT_SHARED_PASSAGE')
    ca,cb,count=match
    # Latest whole second with >=2s common context on both sides; no beat label.
    exit_frame=((ca+count-2*sr)//sr)*sr
    entry_frame=exit_frame+cb-ca
    if exit_frame<max(6*sr,ca+2*sr):raise ValueError('SHARED_PASSAGE_TOO_EARLY')
    start=exit_frame-2*sr;incoming_start=entry_frame-2*sr;length=4*sr
    samples=a[start:start+length].astype('<f4')
    if not np.array_equal(samples,b[incoming_start:incoming_start+length].astype('<f4')):raise ValueError('COMMON_PCM_CHANGED')
    source={'currentSha256':dsp.digest_file(a_file),'incomingSha256':dsp.digest_file(c_file)}
    bridge={'method':'exact-shared-stereo-pcm-v1',**source,'sampleFormat':'float32-le-stereo','sampleRate':sr,'channels':2,
      'currentStartFrame':start,'incomingStartFrame':incoming_start,'frameCount':length,
      'currentPcmSha256':hashlib.sha256(samples.tobytes()).hexdigest(),'incomingPcmSha256':hashlib.sha256(samples.tobytes()).hexdigest(),
      'exactSampleEquality':True,'minimumWindowDbfs':float(dsp.block_levels(samples.astype(float),sr).min()),
      'meaning':'same acoustic passage, no independent-song/key/phrase assertion'}
    s={'type':'shared-pcm-bridge','entryFrame':entry_frame,'exitFrame':exit_frame,'overlapFrames':0,'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':None}
    r=dsp.inspect_pair(a_file,c_file,s,out/'shared-bridge.wav');r['sharedPCM']=bridge
    if not r['passed']:raise ValueError('SHARED_RENDER_QC_FAILED: '+str(r['renderQC']))
    fallback=dsp.inspect_pair(a_file,a_file,{'type':'native-continuation','entryFrame':0,'exitFrame':len(a),'overlapFrames':0,'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':None,'seamDeclickFrames':882},out/'fallback.wav')
    if not fallback['passed']:raise ValueError('FALLBACK_QC_FAILED')
    sources={'current':{'file':a_file.name,'profile':dsp.profile(a_file),'preparation':prior['sources']['variant-A']['preparation']},
      'variant-C':{'file':c_file.name,'profile':dsp.profile(c_file),'preparation':prep}}
    # The unrelated candidates remain in the pool, without any shared receipt.
    for name in ['current','music-B']:
        label='independent-current' if name=='current' else name
        file=out/(label+'.wav');shutil.copyfile(base/(name+'-24.wav'),file)
        sources[label]={'file':file.name,'profile':dsp.profile(file),'preparation':prior['sources'][name]['preparation']}
    after={n:dsp.digest_file(base/n) for n in before}
    if before!=after:raise ValueError('SOURCE_CHANGED')
    catalog={'method':'shared-pcm-bridge-catalog-v1','scope':'saved related recordings with identical conditioning passage; NOT independent songs',
      'sources':sources,'incomingNames':['independent-current','music-B','variant-C'],'pairs':[{'incoming':'variant-C','file':'shared-bridge.wav','receipt':r}],
      'fallback':{'file':'fallback.wav','receipt':fallback},'fullSharedRange':{'currentStart':ca,'incomingStart':cb,'frameCount':count},
      'actualAPIRequests':0,'subjectiveListeningVerified':False,'allOriginalsPreserved':before==after,'sourceHashesBefore':before,'sourceHashesAfter':after}
    (out/'catalog.json').write_text(json.dumps(catalog,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'sharedSeconds':count/sr,'cutSeconds':exit_frame/sr,'renderSeconds':r['renderedFrameCount']/sr,'retainedIncomingSeconds':(len(b)-entry_frame)/sr,'renderSha':r['renderedSha256'],'qc':r['renderQC']}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);prepare(p.parse_args().out)
