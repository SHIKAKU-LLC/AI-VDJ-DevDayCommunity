"""Local, source-bound musical observations; scores are NOT calibrated accuracy.

Dependencies: numpy/scipy/librosa/soundfile; optional existing BeatThis checkpoint.
No model download, network, source rewrite, key/phrase promotion or resampling of
playback audio. Analysis downsampling is recorded separately from render inputs.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy import signal
import librosa

METHOD = 'source-musical-observations-v1'
ANALYSIS_RATE = 22050
HOP = 220
NFFT = 2048
BANDS = [(30, 160), (160, 2500), (2500, 10000)]
KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
TEMPLATES = {'major': [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
             'minor': [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]}


def sha_file(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def cosine(a, b):
    return float(np.dot(a, b) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-15))


def key_hypotheses(chroma):
    """Profile correlations, not probabilities or evidence of harmonic safety."""
    if np.max(chroma, initial=0) < 1e-12:
        return []
    c = chroma - np.mean(chroma)
    values = []
    for scale, template in TEMPLATES.items():
        for tonic in range(12):
            t = np.roll(template, tonic)
            values.append({'key': KEYS[tonic], 'scale': scale, 'correlation': cosine(c, t-t.mean())})
    return sorted(values, key=lambda v: -v['correlation'])[:4]


def pulse_candidates(envelope, fps):
    z = envelope - np.mean(envelope)
    if np.linalg.norm(z) < 1e-10 or len(z) < fps*4:
        return []
    ac = signal.fftconvolve(z, z[::-1], mode='full')[len(z)-1:]
    # Normalise by the energy of each overlapping segment (not by model logits).
    vals = []
    lo, hi = int(fps*60/300), min(int(fps*60/40), len(z)//2)
    for lag in range(max(2, lo), hi+1):
        denom = np.linalg.norm(z[:-lag]) * np.linalg.norm(z[lag:])
        vals.append(float(ac[lag]/max(denom, 1e-15)))
    peaks, _ = signal.find_peaks(vals, distance=3)
    ranked = sorted(peaks, key=lambda i: -vals[i])[:8]
    return [{'bpm': float(60*fps/(i+max(2,lo))), 'correlation': vals[i]} for i in ranked if vals[i] > 0]


def fit_beats(seconds):
    b = np.asarray(seconds, dtype=float)
    if len(b) < 8:
        return {'status':'insufficient', 'beatCount':len(b), 'tempoBpm':None}
    intervals = np.diff(b)
    period = float(np.median(intervals))
    steps = np.maximum(1, np.rint(intervals/period)).astype(int)
    indices = np.r_[0, np.cumsum(steps)]
    slope, intercept = np.polyfit(indices, b, 1)
    residual = b - (intercept + slope*indices)
    return {'status':'estimated', 'beatCount':len(b), 'tempoBpm':float(60/slope),
            'periodSeconds':float(slope), 'interceptSeconds':float(intercept),
            'missingBeatSteps':int(np.sum(steps-1)), 'residualP95Seconds':float(np.percentile(abs(residual),95)),
            'residualMaxSeconds':float(np.max(abs(residual))),
            'intervalMadSeconds':float(np.median(abs(intervals-np.median(intervals)))),
            'calibrated':False, 'meaning':'line fit with explicit skipped-beat indices; not ground-truth tempo'}


def observe_array(x, rate, *, model=None):
    if rate != 44100 or x.ndim != 2 or x.shape[1] != 2 or not np.isfinite(x).all() or len(x) < rate*4:
        raise ValueError('FINITE_44100_STEREO_MINIMUM_FOUR_SECONDS_REQUIRED')
    # Keep channels separate through the spectrum: antiphase material must not
    # disappear through a mono average. Playback remains native 44.1kHz stereo.
    y = librosa.resample(x.T, orig_sr=rate, target_sr=ANALYSIS_RATE, res_type='soxr_hq')
    spectra = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP))
    magnitude = np.sqrt(np.mean(spectra**2, axis=0))
    freqs = librosa.fft_frequencies(sr=ANALYSIS_RATE, n_fft=NFFT)
    log = np.log1p(magnitude*100)
    flux = np.maximum(log[:,1:]-log[:,:-1], 0)
    envelopes = np.stack([np.r_[0, flux[(freqs>=lo)&(freqs<hi)].mean(axis=0)] for lo,hi in BANDS])
    fps = ANALYSIS_RATE/HOP
    pulse = [pulse_candidates(e, fps) for e in envelopes]
    harmonic, percussive = librosa.decompose.hpss(magnitude, margin=3)
    chroma = librosa.feature.chroma_stft(S=harmonic**2, sr=ANALYSIS_RATE, n_fft=NFFT, hop_length=HOP)
    times = np.arange(chroma.shape[1])/fps
    windows=[]
    for start in np.arange(0, len(x)/rate-1.99, 2):
        mask=(times>=start)&(times<start+2)
        power=float(np.sum(magnitude[:,mask]**2))
        c=chroma[:,mask].mean(axis=1)
        windows.append({'startSeconds':float(start),'endSeconds':float(start+2),
          'chroma':c.tolist(),'keyHypotheses':key_hypotheses(c),
          'harmonicEnergyFraction':float(np.sum(harmonic[:,mask]**2)/max(power,1e-15)),
          'percussiveEnergyFraction':float(np.sum(percussive[:,mask]**2)/max(power,1e-15))})
    average = chroma.mean(axis=1)
    result={'method':METHOD,'sampleRate':rate,'channels':2,'frameCount':len(x),
      'analysis':{'sampleRate':ANALYSIS_RATE,'fftSize':NFFT,'hopFrames':HOP,'stereoPowerCombined':True,
        'playbackResampled':False,'hpssMargin':3,'bandEdgesHz':BANDS},
      'pulse':{'status':'estimated' if any(pulse) else 'unknown','bandCandidates':pulse,
        'calibrated':False,'metricalLevel':'unknown','octaveAmbiguous':True,
        'meaning':'repeating acoustic pulses; half/double/triplet alternatives retained'},
      'key':{'status':'estimated' if key_hypotheses(average) else 'unknown',
        'hypotheses':key_hypotheses(average),'calibrated':False,'verified':False,
        'meaning':'Krumhansl profile correlations on HPSS chroma, not probabilities'},
      'phrase':{'status':'unknown','verified':False,'reason':'no validated structural/phrase labels'},
      'windows':windows,'neuralBeats':None,'confidence':{'type':'uncalibrated-observations','calibrated':False}}
    top=result['key']['hypotheses']
    votes=[w['keyHypotheses'][0] for w in windows if w['keyHypotheses']]
    result['key']['topTwoCorrelationMargin']=float(top[0]['correlation']-top[1]['correlation']) if len(top)>1 else None
    result['key']['windowTopLabelAgreement']=float(np.mean([v['key']==top[0]['key'] and v['scale']==top[0]['scale'] for v in votes])) if top and votes else None
    result['key']['reliabilityMeaning']='margin/window agreement describe ambiguity, not calibrated confidence'
    if model:
        tracker, post = model
        logits, down_logits = tracker(x.astype(np.float32), rate)
        beats, downs = post(logits, down_logits)
        beats=np.asarray(beats);downs=np.asarray(downs)
        fit=fit_beats(beats)
        onset=envelopes.sum(axis=0)
        peaks,_=signal.find_peaks(onset, distance=round(fps*.1), prominence=max(float(onset.max())*.05,1e-10))
        pt=peaks/fps
        distances=np.array([min(abs(pt-t)) if len(pt) else 1. for t in beats])
        result['neuralBeats']={'seconds':beats.tolist(),'sourceFrames':np.rint(beats*rate).astype(int).tolist(),
          'downbeatSeconds':downs.tolist(),'fit':fit,'frameQuantizationSeconds':.02,
          'medianPeakProbability':float(np.median(logits.sigmoid().detach().cpu().numpy()[np.clip(np.rint(beats*50).astype(int),0,len(logits)-1)])) if len(beats) else None,
          'modelProbabilitiesCalibrated':False,'downbeatsVerified':False,
          'onsetAgreement':{'toleranceSeconds':.03,'fraction':float(np.mean(distances<=.03)) if len(beats) else 0.,
            'p95DistanceSeconds':float(np.percentile(distances,95)) if len(beats) else None,
            'meaning':'independent spectral-flux support; not annotation accuracy'}}
    return result


def analyze(path, *, model=None, model_info=None):
    before=sha_file(path)
    x,rate=sf.read(path,always_2d=True,dtype='float32')
    if sha_file(path)!=before:raise ValueError('SOURCE_CHANGED_DURING_ANALYSIS')
    v=observe_array(x,rate,model=model)
    v['assetSha256']=before
    v['pcmSha256']=hashlib.sha256(x.astype('<f4').tobytes()).hexdigest()
    v['extractorSha256']=sha_file(__file__)
    v['dependencies']={k:importlib.metadata.version(k) for k in ['numpy','scipy','librosa','soundfile']}
    v['model']=model_info
    return v


def load_model(path):
    p=Path(path).resolve(strict=True)  # explicit local path; no automatic download
    import torch
    from beat_this.inference import Audio2Frames
    from beat_this.model.postprocessor import Postprocessor
    torch.set_num_threads(2)
    return (Audio2Frames(checkpoint_path=str(p),device='cpu',float16=False),Postprocessor(type='minimal')), {
      'name':'Beat This!','checkpointSha256':sha_file(p),'packageVersion':importlib.metadata.version('beat-this'),
      'device':'cpu','probabilitiesCalibrated':False,'downloadedThisRun':False}


def propose(a,b, *, minimum_lead_seconds=6):
    """Generate measurable geometry, while keeping missing musical proof explicit."""
    ra=a.get('neuralBeats');rb=b.get('neuralBeats')
    if not ra or not rb or ra['fit']['tempoBpm'] is None or rb['fit']['tempoBpm'] is None:
        return {'status':'HOLD','reasons':['BEAT_OBSERVATIONS_UNAVAILABLE'],'plans':[]}
    rate=a['sampleRate'];ad=ra['downbeatSeconds'];bd=rb['downbeatSeconds']
    period=(ra['fit']['periodSeconds']+rb['fit']['periodSeconds'])/2
    duration=a['frameCount']/rate
    plans=[]
    for bars in [1,2,4]:
        n=2*round(4*bars*period*rate/2)
        for exit_s in ad:
            if exit_s-n/rate/2<minimum_lead_seconds or exit_s+n/rate/2>duration:continue
            for entry_s in bd:
                if entry_s-n/rate/2<0 or entry_s+n/rate/2>b['frameCount']/rate or entry_s>duration*.5:continue
                aa=np.asarray(ra['seconds']);bb=np.asarray(rb['seconds'])+exit_s-entry_s
                selected=aa[(aa>=exit_s-n/rate/2)&(aa<=exit_s+n/rate/2)]
                phase=max([min(abs(bb-t))/period for t in selected],default=1.)
                wa=[w for w in a['windows'] if w['endSeconds']>exit_s-n/rate/2 and w['startSeconds']<exit_s+n/rate/2]
                wb=[w for w in b['windows'] if w['endSeconds']>entry_s-n/rate/2 and w['startSeconds']<entry_s+n/rate/2]
                local_similarity=cosine(np.mean([w['chroma'] for w in wa],axis=0),np.mean([w['chroma'] for w in wb],axis=0))
                reasons=['DOWNBEAT_LABEL_UNVALIDATED','PHRASE_UNVERIFIED','LOCAL_HARMONY_UNCALIBRATED']
                gap=abs(ra['fit']['tempoBpm']-rb['fit']['tempoBpm'])
                if gap>1:reasons.append('ESTIMATED_TEMPO_GAP')
                if phase>.08:reasons.append('OBSERVED_PHASE_MISMATCH')
                if min(ra['onsetAgreement']['fraction'],rb['onsetAgreement']['fraction'])<.8:reasons.append('WEAK_INDEPENDENT_ONSET_SUPPORT')
                plans.append({'status':'HOLD','reasons':reasons,'currentSha256':a['assetSha256'],'incomingSha256':b['assetSha256'],
                  'spec':{'type':'bass-swap','entryFrame':round(entry_s*rate),'exitFrame':round(exit_s*rate),
                    'overlapFrames':n,'sampleRate':rate,'relativeIncomingGainDb':0},
                  'planningBars':bars,'barsVerified':False,'observedPhaseErrorBeats':float(phase),
                  'estimatedTempoGap':gap,'localChromaCosine':local_similarity,'localHarmonyVerified':False,
                  'reviewCost':float(phase+gap/10+1-local_similarity),
                  'meaning':'rank for review/render, never automatic adoption; geometry comes from observed positions'})
    plans.sort(key=lambda p:p['reviewCost'])
    return {'status':'HOLD','reasons':['NO_VALIDATED_INDEPENDENT_MUSICAL_RECEIPT'],'plans':plans[:12]}


if __name__=='__main__':
    cli=argparse.ArgumentParser();cli.add_argument('--catalog',required=True);cli.add_argument('--out',required=True);cli.add_argument('--checkpoint')
    args=cli.parse_args();source=Path(args.catalog).resolve();out=Path(args.out)
    if out.exists():raise ValueError('EXISTING_ANALYSIS_PRESERVED')
    data=json.loads(source.read_text());model=model_info=None
    if args.checkpoint:model,model_info=load_model(args.checkpoint)
    observations={name:analyze(source.parent/s['file'],model=model,model_info=model_info) for name,s in data['sources'].items()}
    plans={name:propose(observations['current'],v) for name,v in observations.items() if name!='current'}
    result={'method':'musical-plan-review-v1','sourceCatalogSha256':sha_file(source),'observations':observations,'pairPlans':plans,
      'automaticIndependentAdoption':False,'actualAPIRequests':0,'subjectiveListeningVerified':False}
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    for name,p in plans.items():print(name,p['status'],'candidate plans',len(p['plans']))
