"""Offline PCM measurements and candidate renders. No network/model downloads.

This lightweight rhythm/structure analysis is a proxy, not a trained beat,
downbeat, phrase or key detector. Proxy confidence never authorizes LIVE mixing.
Frame positions are source-local, centered on the transition; overlap is even.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess

import numpy as np
import soundfile as sf


def digest_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def digest_object(value):
    # Match JSON.stringify after the worker reply crosses the JSON boundary.
    # Python emits1.0/0.0 while JavaScript emits1/0 for integral measurements.
    def canonical(v):
        if isinstance(v, float) and math.isfinite(v) and v.is_integer(): return int(v)
        if isinstance(v, dict): return {k:canonical(x) for k,x in v.items()}
        if isinstance(v, list): return [canonical(x) for x in v]
        return v
    return hashlib.sha256(json.dumps(canonical(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def db(v):
    return float(20 * np.log10(max(float(v), 1e-15)))


def rms(x):
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.


def pcm16_exact(x):
    # The integer grid a PCM16 WAV decodes from (value * 32768), clipped.
    return np.clip(np.floor(np.asarray(x) * 32768 + .5), -32768, 32767).astype(np.int16)


def write_render(output_path, x, sr, sources):
    # A render copies its sources' samples verbatim around the edit. Keep it
    # PCM16 (half the bytes) only when every source is PCM16, so the copied
    # prefix/tail stay bit-identical to what is already queued; otherwise FLOAT.
    if all(sf.info(str(path)).subtype == 'PCM_16' for path in sources):
        sf.write(output_path, pcm16_exact(x), sr, subtype='PCM_16')
    else:
        sf.write(output_path, x, sr, subtype='FLOAT')


def read_audio(path):
    x, sr = sf.read(path, dtype='float64', always_2d=True)
    if sr != 44100 or x.shape[1] != 2 or not len(x):
        raise ValueError('44100Hz stereo source required; no hidden resampling')
    if not np.isfinite(x).all():
        raise ValueError('NONFINITE_PCM')
    return x, sr


def filtered(x, sr):
    proc = subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '2',
                           '-i', 'pipe:0', '-af', 'lowpass=f=160:poles=2', '-f', 'f32le', 'pipe:1'],
                          input=x.astype('<f4').tobytes(), capture_output=True, check=True)
    return np.frombuffer(proc.stdout, dtype='<f4').reshape(-1, 2).astype(float)


def block_levels(x, sr, seconds=.1):
    hop = max(1, round(sr * seconds))
    # Include a final partial block, so a silent suffix cannot disappear.
    return np.array([db(rms(x[i:i + hop])) for i in range(0, len(x), hop)])


def longest_run(mask, seconds):
    best = run = 0
    for value in mask:
        run = run + 1 if value else 0
        best = max(best, run)
    return best * seconds


def band_fractions(x, sr):
    n = min(len(x), sr * 2)
    # Sum stereo powers rather than averaging channels (antiphase-safe).
    spectrum = np.fft.rfft(x[:n] * np.hanning(n)[:, None], axis=0)
    power = np.sum(abs(spectrum) ** 2, axis=1)
    f = np.fft.rfftfreq(n, 1 / sr)
    bands = [float(power[(f >= lo) & (f < hi)].sum()) for lo, hi in [(0, 160), (160, 2500), (2500, sr / 2 + 1)]]
    total = sum(bands)
    return [v / total for v in bands] if total else [0., 0., 1.]


def rhythm_proxy(x, sr):
    low = filtered(x, sr)
    hop = round(sr * .01)
    blocks = low[:len(low) // hop * hop].reshape(-1, hop, 2)
    if len(blocks) < 300:
        return {'confidence':'proxy', 'confidenceScore':0., 'octaveAmbiguous':True, 'value':None, 'supports':[]}
    env = np.sqrt(np.mean(blocks * blocks, axis=(1, 2)))
    onset = np.maximum(np.diff(np.log(np.maximum(env, 1e-9)), prepend=0), 0)
    z = onset - onset.mean()
    values = []
    for bpm in range(60, 201):
        lag = round(6000 / bpm)
        a, b = z[:-lag], z[lag:]
        support = float(np.dot(a, b) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12))
        values.append((max(0., support), bpm))
    values.sort(reverse=True)
    score, bpm = values[0]
    aliases = [v for v in values if abs(v[1] - bpm / 2) < 4 or abs(v[1] - bpm * 2) < 4]
    ambiguous = any(v[0] >= score * .8 for v in aliases) or score < .5
    return {'value':bpm, 'confidence':'proxy', 'confidenceScore':score, 'octaveAmbiguous':ambiguous,
            'supports':[{'bpm':b, 'correlation':s} for s, b in values[:6]],
            'beatGridVerified':False, 'downbeatVerified':False, 'phraseVerified':False,
            'meaning':'low-band onset periodicity; tempo octave and metrical origin unverified'}


def loudness(x, sr):
    # loudnorm used for analysis only: stdout discarded; no normalization in render.
    proc = subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-hide_banner', '-f', 'f32le', '-ar', str(sr), '-ac', '2',
                           '-i', 'pipe:0', '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'],
                          input=x.astype('<f4').tobytes(), capture_output=True, check=True)
    log = proc.stderr.decode()
    data = json.loads(log[log.rfind('{'):log.rfind('}') + 1])
    def value(k):
        f = float(data[k])
        return f if math.isfinite(f) else None
    return {'truePeakDbtp':value('input_tp'), 'integratedLufs':value('input_i'), 'loudnessRangeLu':value('input_lra'),
            'method':'ffmpeg-loudnorm-input-analysis', 'normalizationApplied':False}


def prepare_headroom(input_path, output_path, *, target_lufs=-18., ceiling_dbtp=-1., start_frame=0, end_frame=None, gain_db=None):
    """Non-destructive static-gain preparation, preserving transient dynamics.

    Never pad/loop/stretch a short source or overwrite the input. Report every
    trim and the original asset SHA. Static gain suffices when no loudness boost
    is necessary; this deliberately does not disguise a damaged waveform.
    """
    if Path(input_path).resolve() == Path(output_path).resolve():
        raise ValueError('ORIGINAL_OVERWRITE_REFUSED')
    x, sr = read_audio(input_path)
    end = len(x) if end_frame is None else end_frame
    if type(start_frame) is not int or type(end) is not int or not 0 <= start_frame < end <= len(x):
        raise ValueError('INVALID_PREPARATION_RANGE')
    y = x[start_frame:end].copy()
    before = loudness(y, sr)
    if before['integratedLufs'] is None or before['truePeakDbtp'] is None:
        raise ValueError('NO_ACTIVE_AUDIO_TO_PREPARE')
    chosen_gain = min(0.,target_lufs-before['integratedLufs'],ceiling_dbtp-before['truePeakDbtp']-.1) if gain_db is None else gain_db
    if not math.isfinite(chosen_gain) or chosen_gain > 0 or chosen_gain < -30:
        raise ValueError('UNSAFE_PREPARATION_GAIN')
    y *= 10 ** (chosen_gain/20)
    sf.write(output_path,y,sr,subtype='FLOAT')
    actual, _ = read_audio(output_path)
    after = loudness(actual,sr)
    if after['truePeakDbtp'] is None or after['truePeakDbtp'] > ceiling_dbtp:
        raise ValueError('PREPARED_TRUE_PEAK_STILL_UNSAFE')
    return {'method':'static-headroom-gain-v1','originalSha256':digest_file(input_path),'preparedSha256':digest_file(output_path),
            'sourceStartFrame':start_frame,'sourceEndFrame':end,'sourceFrameCount':len(x),'preparedFrameCount':len(actual),
            'gainDb':chosen_gain,'targetLufs':target_lufs,'ceilingDbtp':ceiling_dbtp,'before':before,'after':after,
            'durationSeconds':len(actual)/sr,'room24SecondDurationEligible':abs(len(actual)/sr-24)<=.15,
            'sampleRate':sr,'timeStretch':False,'pitchShift':False,'padding':False,'looping':False,'limiterApplied':False,
            'meaning':'static attenuation preserves dynamics; existing source clipping shape is not reconstructed'}


def profile(path):
    x, sr = read_audio(path)
    levels = block_levels(x, sr)
    edge = min(sr * 2, len(x))
    window = lambda a: {'rmsDbfs':db(rms(a)), 'bandFractions':band_fractions(a, sr)}
    return {'method':'pcm-endpoint-profile-v1', 'assetSha256':digest_file(path), 'sampleRate':sr, 'channels':2,
            'frameCount':len(x), 'durationSeconds':len(x) / sr, 'rmsDbfs':db(rms(x)),
            'head':window(x[:edge]), 'tail':window(x[-edge:]), 'samplePeakDbfs':db(np.max(abs(x))),
            'clippedFraction':float(np.mean(abs(x) >= .999)), 'nonfiniteSamples':0,
            'activity':{'effectiveSilence':db(rms(x)) < -45, 'maxQuietRunSeconds':longest_run(levels < -45, .1),
                        'quietFraction':float(np.mean(levels < -45)), 'minimumWindowDbfs':float(levels.min()),
                        'thresholdDbfs':-45, 'windowSeconds':.1},
            'bpm':rhythm_proxy(x, sr), 'key':{'value':None, 'confidence':'unknown', 'confidenceScore':0.,
                'reason':'trained/local harmonic evidence unavailable; requested key is not evidence'},
            'phrase':{'confidence':'unknown', 'phraseVerified':False, 'reason':'metrical and structural boundaries unverified'},
            'loudness':loudness(x, sr)}


def bass_curves(overlap_frames, sr):
    # At least one zero node between owners; interpolation never doubles bass.
    width = min(.01 * sr / overlap_frames, .1)
    return [{'position':0, 'outgoingLow':1, 'incomingLow':0},
            {'position':.5 - width, 'outgoingLow':1, 'incomingLow':0},
            {'position':.5, 'outgoingLow':0, 'incomingLow':0},
            {'position':.5 + width, 'outgoingLow':0, 'incomingLow':1},
            {'position':1, 'outgoingLow':0, 'incomingLow':1}]


def validate_geometry(spec, a, b, sr, *, played_until_frame=0, prior_incoming_end=0):
    if spec['sampleRate'] != sr or any(type(spec[k]) is not int or spec[k] < 0 for k in ['entryFrame', 'exitFrame', 'overlapFrames']):
        raise ValueError('INVALID_FRAMES')
    o, e, n = spec['exitFrame'], spec['entryFrame'], spec['overlapFrames']
    declick=spec.get('seamDeclickFrames',0)
    if type(declick) is not int or declick<0 or declick%2 or declick>round(.02*sr):
        raise ValueError('INVALID_NATIVE_DECLICK_BUDGET')
    if declick and (spec['type'] not in ['native-continuation','measured-nonoverlap-cut'] or n or declick//2>min(o,len(b)-e)):
        raise ValueError('INVALID_NATIVE_DECLICK_GEOMETRY')
    if n % 2 or o - n // 2 < 0 or e - n // 2 < 0 or o + n // 2 > len(a) or e + n // 2 >= len(b):
        raise ValueError('OVERLAP_EXCEEDS_SOURCE')
    if o - max(n,declick) // 2 < max(played_until_frame, prior_incoming_end):
        raise ValueError('LATE_OR_OVERLAPPING_CUE')
    if not math.isfinite(spec['relativeIncomingGainDb']) or abs(spec['relativeIncomingGainDb']) > 3:
        raise ValueError('GAIN_BUDGET_EXCEEDED')
    if spec['type'] in ['native-continuation','saved-contiguous'] and (n != 0 or e != 0 or o != len(a)):
        raise ValueError('NATIVE_ENDPOINT_REQUIRED')


def render_pair(a, b, sr, spec, *, played_until_frame=0, prior_incoming_end=0):
    validate_geometry(spec, a, b, sr, played_until_frame=played_until_frame, prior_incoming_end=prior_incoming_end)
    if not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError('NONFINITE_PCM')
    n, o, e = spec['overlapFrames'], spec['exitFrame'], spec['entryFrame']
    gain = 10 ** (spec['relativeIncomingGainDb'] / 20)
    if n == 0:
        output=np.concatenate([a[:o], b[e:] * gain])
        half=spec.get('seamDeclickFrames',0)//2
        if half:
            output[o-half:o]*=np.cos(np.linspace(0,np.pi/2,half))[:,None]
            output[o:o+half]*=np.sin(np.linspace(0,np.pi/2,half))[:,None]
        return output, o, 0
    left, right = o - n // 2, e - n // 2
    outgoing, incoming = a[left:left + n], b[right:right + n] * gain
    t = np.linspace(0, 1, n)
    if spec['type'] in ['bass-swap','conditioned-context-overlap','measured-overlap-crossfade']:
        curves = spec['eqCurves']
        if curves != bass_curves(n, sr):
            raise ValueError('UNSUPPORTED_EQ_CURVE')
        lo1, lo2 = filtered(a, sr)[left:left + n], filtered(b, sr)[right:right + n] * gain
        out_low = np.interp(t, [p['position'] for p in curves], [p['outgoingLow'] for p in curves])
        in_low = np.interp(t, [p['position'] for p in curves], [p['incomingLow'] for p in curves])
        # Reconstructed matching context is correlated. Complementary linear
        # weights avoid the equal-power gain bump on that same passage.
        out_high,in_high=(1-t,t) if spec['type']=='conditioned-context-overlap' else (np.cos(t*np.pi/2),np.sin(t*np.pi/2))
        blend = (outgoing - lo1) * out_high[:,None] + (incoming - lo2) * in_high[:,None]
        blend += lo1 * out_low[:, None] + lo2 * in_low[:, None]
        double = int(np.sum((out_low > 0) & (in_low > 0)))
    elif spec['type'] == 'equal-power-baseline':
        blend = outgoing * np.cos(t * np.pi / 2)[:, None] + incoming * np.sin(t * np.pi / 2)[:, None]
        double = int(np.sum((t > 0) & (t < 1)))
    else:
        raise ValueError('UNSUPPORTED_TRANSITION')
    return np.concatenate([a[:left], blend, b[right + n:] * gain]), o, double


def render_metrics(x, sr, seam, bass_double):
    levels = block_levels(x, sr)
    # Level steps use 400ms windows around the splice, so individual kick cycles
    # are not mislabeled as a transition loudness discontinuity.
    width = round(.4 * sr)
    start, end = max(0, seam - 2 * sr), min(len(x), seam + 2 * sr)
    local = np.array([db(rms(x[i:i + width])) for i in range(start, max(start, end - width) + 1, round(.1 * sr))])
    edge = x[max(0, seam - 2):min(len(x), seam + 2)]
    metrics = {'clippedFraction':float(np.mean(abs(x) >= .999)), 'nonfiniteSamples':int(np.sum(~np.isfinite(x))),
               'maxQuietRunSeconds':longest_run(levels < -45, .1), 'minimumWindowDbfs':float(levels.min()),
               'maxLevelStepDb':float(np.max(abs(np.diff(local)))) if len(local) > 1 else 0.,
               'seamJump':float(np.max(abs(np.diff(edge, axis=0)))) if len(edge) > 1 else 0.,
               'bassDoubleOwnershipFrames':bass_double, 'samplePeakDbfs':db(np.max(abs(x))),
               'windowSeconds':.1, 'quietThresholdDbfs':-45}
    metrics.update(loudness(x, sr))
    low_levels = block_levels(filtered(x[start:end], sr), sr)
    metrics['localLowBand'] = {'method':'ffmpeg-160Hz-lowpass-100ms-rms',
                              'minimumDbfs':float(low_levels.min()), 'maximumDbfs':float(low_levels.max()),
                              'maximumStepDb':float(np.max(abs(np.diff(low_levels)))) if len(low_levels)>1 else 0.}
    return metrics


def qc_reasons(m):
    checks = [('TRUE_PEAK_OR_CLIP', m['truePeakDbtp'] is None or m['truePeakDbtp'] > -.3 or m['clippedFraction'] > 0),
              ('EFFECTIVE_SILENCE', m['maxQuietRunSeconds'] > .15 or m['minimumWindowDbfs'] < -45),
              ('LEVEL_STEP', m['maxLevelStepDb'] > 6), ('SEAM_ARTIFACT_PROXY', m['seamJump'] > .15),
              ('DOUBLE_BASS_OWNERSHIP', m['bassDoubleOwnershipFrames'] > 0),
              ('NONFINITE', m['nonfiniteSamples'] > 0),
              # Same 3 dB ceiling the live selector applies to an overlap's
              # rendered low band; a receipt it would reject must not pass here.
              ('LOW_BAND_LIFT', (m.get('overlapLowBandLiftDb') or 0) > 3)]
    return [name for name, failed in checks if failed]


def inspect_pair(current_path, incoming_path, spec, output_path, *, revision=0, native_binding=None):
    if Path(output_path).resolve() in [Path(current_path).resolve(),Path(incoming_path).resolve()]:
        raise ValueError('ORIGINAL_OVERWRITE_REFUSED')
    a, sr = read_audio(current_path)
    b, _ = read_audio(incoming_path)
    x, seam, double = render_pair(a, b, sr, spec)
    # FLOAT unless both sources are PCM16 (then exact PCM16, half the bytes).
    # Clipping is still measured below on the rendered file itself.
    write_render(output_path, x, sr, [current_path, incoming_path])
    rendered, _ = read_audio(output_path)
    metrics = render_metrics(rendered, sr, seam, double)
    # Measure low-frequency gain in the exact rendered blend against both
    # source windows. Ownership count is a curve invariant, not acoustic proof.
    n = spec['overlapFrames']
    if n:
        o, e = spec['exitFrame'] - n//2, spec['entryFrame'] - n//2
        low_a = filtered(a, sr)[o:o+n]
        low_b = filtered(b, sr)[e:e+n] * 10 ** (spec['relativeIncomingGainDb']/20)
        low_y = filtered(rendered, sr)[o:o+n]
        metric = lambda low: float(np.percentile(block_levels(low, sr),90))
        metrics['overlapLowBandLiftDb'] = metric(low_y) - max(metric(low_a),metric(low_b))
        av, bv = low_a.reshape(-1),low_b.reshape(-1)
        metrics['overlapLowBandCorrelation'] = float(np.dot(av,bv)/max(np.linalg.norm(av)*np.linalg.norm(bv),1e-12))
    else:
        metrics['overlapLowBandLiftDb'] = 0.
        metrics['overlapLowBandCorrelation'] = None
    reasons = qc_reasons(metrics)
    native = native_binding or {}
    native_verified = spec['type'] == 'native-continuation' and native.get('verified') is True
    receipt = {'method':'rendered-transition-qc-v1', 'passed':not reasons, 'currentSha256':digest_file(current_path),
               'incomingSha256':digest_file(incoming_path), 'currentPlaybackRevision':revision,
               'currentFrameCount':len(a), 'incomingFrameCount':len(b), **spec,
               'renderedSha256':digest_file(output_path), 'renderedFrameCount':len(rendered),
               'renderSpecSha256':digest_object(spec), 'renderMetrics':metrics,
               'renderQC':{'passed':not reasons, 'reasons':reasons, 'scope':'objective PCM feasibility; no listening verdict'},
               'beatGridVerified':False, 'downbeatVerified':False, 'phraseVerified':False,
               'beatConfidence':0., 'downbeatConfidence':0., 'phraseConfidence':0., 'beatPhaseError':None,
               'bassCollisionManaged':double == 0, 'loudnessVerified':True,
               'nativeContinuationVerified':native_verified, 'parentSha256':native.get('parentSha256'),
               'contextSha256':native.get('contextSha256'), 'contextAnchorFrame':native.get('contextAnchorFrame'),
               'subjectiveListeningEvaluated':False, 'timeStretch':False, 'pitchShift':False}
    if spec['type']=='measured-nonoverlap-cut':
        receipt['measuredCutPolicy']='objective-nonoverlap-no-musical-grid-claim-v1'
    if spec['type']=='measured-overlap-crossfade':
        receipt['measuredCrossfadePolicy']='objective-overlap-crossfade-no-musical-grid-claim-v1'
    return receipt


def candidate_specs(a_frames, b_frames, sr, assumed_bpm=140):
    # Fixed-tempo variants for OFFLINE comparison; no inferred phrase claim.
    specs = [{'type':'native-continuation', 'entryFrame':0, 'exitFrame':a_frames,
              'overlapFrames':0, 'sampleRate':sr, 'relativeIncomingGainDb':0, 'eqCurves':None}]
    for label, seconds in [('equal-power-baseline', 4.), ('bass-swap', 8 * 60 / assumed_bpm), ('bass-swap', 16 * 60 / assumed_bpm)]:
        n = 2 * round(seconds * sr / 2)
        if n >= min(a_frames, b_frames):
            continue
        specs.append({'type':label, 'entryFrame':n // 2, 'exitFrame':a_frames - n // 2,
                      'overlapFrames':n, 'sampleRate':sr, 'relativeIncomingGainDb':0,
                      'eqCurves':bass_curves(n, sr) if label == 'bass-swap' else None})
    return specs


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile')
    parser.add_argument('--prepare')
    parser.add_argument('--start-frame',type=int,default=0)
    parser.add_argument('--end-frame',type=int)
    parser.add_argument('--target-lufs',type=float,default=-18.)
    parser.add_argument('--ceiling-dbtp',type=float,default=-1.)
    parser.add_argument('--current')
    parser.add_argument('--incoming')
    parser.add_argument('--spec')
    parser.add_argument('--output')
    parser.add_argument('--revision', type=int, default=0)
    args = parser.parse_args()
    if args.profile:
        print(json.dumps(profile(args.profile), allow_nan=False))
    elif args.prepare:
        print(json.dumps(prepare_headroom(args.prepare,args.output,target_lufs=args.target_lufs,
            ceiling_dbtp=args.ceiling_dbtp,start_frame=args.start_frame,end_frame=args.end_frame),allow_nan=False))
    else:
        print(json.dumps(inspect_pair(args.current, args.incoming, json.loads(Path(args.spec).read_text()),
                                      args.output, revision=args.revision), allow_nan=False))
