"""Offline trusted decoder. Reads staged copies only; never fetches or generates media."""
import argparse, hashlib, importlib.util, json, math, os, re, struct, subprocess
from pathlib import Path
import numpy as np
import soundfile as sf

VERSION = 'portable-media-qc-v1'
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def stable_derived_wave(path,request):
    # libsndfile FLOAT WAV embeds the wall clock in PEAK metadata. Normalize
    # only that timestamp on worker-owned outputs; PCM/fmt/peak values remain.
    if request.get('artifactEncoding')!='stable-peak-timestamp-v2': return
    b=bytearray(Path(path).read_bytes());p=12
    if b[:4]!=b'RIFF' or b[8:12]!=b'WAVE' or struct.unpack_from('<I',b,4)[0]+8!=len(b):
        raise ValueError('COMPLETE_DERIVED_WAVE_REQUIRED')
    while p<len(b):
        if p+8>len(b): raise ValueError('PARTIAL_DERIVED_WAVE_CHUNK')
        n=struct.unpack_from('<I',b,p+4)[0]
        if p+8+n>len(b): raise ValueError('PARTIAL_DERIVED_WAVE_DATA')
        if b[p:p+4]==b'PEAK':
            if n<8: raise ValueError('DERIVED_PEAK_METADATA_REQUIRED')
            b[p+12:p+16]=b'\0'*4
        p+=8+n+n%2
    if p!=len(b): raise ValueError('DERIVED_WAVE_CHUNKS_REQUIRED')
    Path(path).write_bytes(b)

def inspect_stable_pair(dsp,current,incoming,specification,output,request,**kwargs):
    receipt=dsp.inspect_pair(current,incoming,specification,output,**kwargs)
    # The measured PCM is unchanged. Bind the receipt to the final file bytes.
    stable_derived_wave(output,request);receipt['renderedSha256']=sha(output)
    return receipt
def wave(path):
    b = Path(path).read_bytes()
    if len(b) < 44 or b[:4] != b'RIFF' or b[8:12] != b'WAVE' or struct.unpack_from('<I', b, 4)[0] + 8 != len(b):
        raise ValueError('COMPLETE_RIFF_WAVE_REQUIRED')
    p, chunks = 12, {}
    while p < len(b):
        if p+8 > len(b): raise ValueError('PARTIAL_WAVE_CHUNK')
        tag, size = b[p:p+4], struct.unpack_from('<I', b, p+4)[0]
        if p+8+size > len(b): raise ValueError('PARTIAL_WAVE_DATA')
        if tag in (b'fmt ', b'data'):
            if tag in chunks: raise ValueError('DUPLICATE_WAVE_CHUNK')
            chunks[tag] = b[p+8:p+8+size]
        p += 8+size+(size%2)
    if p != len(b) or b'fmt ' not in chunks or b'data' not in chunks: raise ValueError('WAVE_CHUNKS_REQUIRED')
    fmt = chunks[b'fmt ']
    if len(fmt)<16: raise ValueError('WAVE_FORMAT_REQUIRED')
    encoding,channels,rate,byte_rate,align,bits = struct.unpack_from('<HHIIHH',fmt)
    if rate!=44100 or channels!=2 or (encoding,bits) not in [(1,16),(3,32)] or align!=channels*bits//8 or byte_rate!=rate*align or len(chunks[b'data'])%align:
        raise ValueError('EXACT_44100_STEREO_PCM_REQUIRED')
    x,sr = sf.read(path,dtype='float64',always_2d=True)
    if not len(x) or not np.isfinite(x).all(): raise ValueError('NONFINITE_OR_EMPTY_PCM')
    return x,sr

def audio(args,request):
    spec=importlib.util.spec_from_file_location('trusted_dsp',args.dsp)
    dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)
    root=Path(args.directory); raw=root/'input.wav'; parent=root/'parent.wav'; context=root/'context.wav'
    x,sr=wave(raw);a,_=wave(parent);c,_=wave(context)
    if len(a)<16*sr or len(c)!=16*sr: raise ValueError('16_SECOND_CONTEXT_REQUIRED')
    # Match the existing saved-context PCM16 quantization, including clipping.
    q=lambda v: np.clip(np.floor(v*32768+.5),-32768,32767)/32768
    context_ok=np.array_equal(q(a[-16*sr:]),c)
    layout=request['layout'];prefix_ok=True
    if layout=='context-plus-tail':
        if len(x)!=40*sr: raise ValueError('EXACT_40_SECOND_CONTEXT_PLUS_TAIL_REQUIRED')
        prefix_ok=np.array_equal(x[:16*sr],c);tail=x[16*sr:]
        # PCM16 on the same exact integer grid as the saved context (half the
        # bytes of FLOAT); joins between PCM16 Cues are then PCM16 as well.
        cue=root/'cue.wav';sf.write(cue,np.clip(np.floor(tail*32768+.5),-32768,32767).astype(np.int16),sr,subtype='PCM_16');stable_derived_wave(cue,request)
    elif layout=='tail-only':
        if len(x)!=24*sr: raise ValueError('EXACT_24_SECOND_TAIL_REQUIRED')
        cue=raw
    else: raise ValueError('LAYOUT_REQUIRED')
    profile=dsp.profile(cue)
    conditioned=None;transition=None
    if layout=='context-plus-tail' and (not prefix_ok or profile['loudness']['truePeakDbtp']>-.3 or profile['activity']['maxQuietRunSeconds']>.5):
        # Keep one contiguous 24s range. Up to4s of reconstructed conditioning
        # can overlap its real parent's matching endpoint; never pad/repeat.
        # A quiet 250ms block is not an endpoint. A gradual musical fade can
        # cross that heuristic before20s while still contain a usable20s tail.
        # Try at most9 contiguous ranges, longest first. The existing complete
        # rendered-transition QC must pass; never move/waive its thresholds.
        for tail_frames in range(24*sr,20*sr-1,-sr//2):
            end=16*sr+tail_frames;start=end-24*sr;n=16*sr-start
            cue=root/'cue.wav';gain=dsp.prepare_headroom(raw,cue,start_frame=start,end_frame=end)
            stable_derived_wave(cue,request)
            profile=dsp.profile(cue)
            if profile['activity']['maxQuietRunSeconds']>.5: continue
            candidate_spec={'type':'conditioned-context-overlap' if n else 'conditioned-continuation',
              'entryFrame':n//2,'exitFrame':len(a)-n//2,'overlapFrames':n,'sampleRate':sr,'relativeIncomingGainDb':0,
              'eqCurves':dsp.bass_curves(n,sr) if n else None}
            candidate=inspect_stable_pair(dsp,parent,cue,candidate_spec,root/'transition.wav',request,revision=request['playbackRevision'],
              native_binding={'verified':False,'parentSha256':sha(parent),'contextSha256':sha(context),'contextAnchorFrame':len(a)})
            if candidate['passed'] and candidate['renderQC']['passed']:
                transition=candidate;break
        else: raise ValueError('INSUFFICIENT_ACTIVE_CONTINUATION')
        y,_=wave(cue)
        corr=lambda u,v: float(np.corrcoef(u.reshape(-1),v.reshape(-1))[0,1])
        conditioned={'kind':'measured-provider-conditioned-cue-v1','rawSha256':sha(raw),'parentSha256':sha(parent),
          'contextSha256':sha(context),'cueSha256':sha(cue),'sampleRate':sr,'rawFrameCount':len(x),
          'cueFrameCount':len(y),'rawStartFrame':start,'rawEndFrame':end,'contextOverlapFrames':n,'newTimelineFrames':len(y)-n,
          'conditioningCorrelation':corr(x[:16*sr],c),'overlapCorrelation':corr(a[-n:],y[:n]) if n else None,
          'gainDb':gain['gainDb'],'timeStretch':False,'pitchShift':False,'padding':False,'looping':False,
          'bitIdenticalPrefixClaimed':False,'clippingWaveformReconstructed':False}
    n=conditioned['contextOverlapFrames'] if conditioned else 0
    transition_spec={'type':('conditioned-context-overlap' if n else 'conditioned-continuation') if conditioned else 'native-continuation',
      'entryFrame':n//2,'exitFrame':len(a)-n//2,'overlapFrames':n,'sampleRate':sr,'relativeIncomingGainDb':0,
      'eqCurves':dsp.bass_curves(n,sr) if n else None}
    if transition is None:
        transition=inspect_stable_pair(dsp,parent,cue,transition_spec,root/'transition.wav',request,revision=request['playbackRevision'],native_binding={'verified':context_ok and prefix_ok and not conditioned,'parentSha256':sha(parent),'contextSha256':sha(context),'contextAnchorFrame':len(a)})
    if conditioned: transition['conditionedContinuationSha256']=dsp.digest_object(conditioned)
    return {'method':VERSION,'inputDigest':request['inputDigest'],'rawSha256':sha(raw),'parentSha256':sha(parent),'contextSha256':sha(context),
      'cueSha256':sha(cue),'cueFile':cue.name,'profile':profile,'transition':transition,'parentFrameCount':len(a),'contextFrameCount':len(c),
      'contextMatchesCurrentTail':bool(context_ok),'contextPrefixMatches':bool(prefix_ok),'conditionedContinuation':conditioned,'dspSha256':sha(args.dsp)}

def join(args,request):
    spec=importlib.util.spec_from_file_location('trusted_dsp',args.dsp)
    dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)
    root=Path(args.directory);current=root/'parent.wav';incoming=root/'input.wav'
    a,sr=wave(current);b,_=wave(incoming)
    if len(a)!=24*sr or len(b)!=24*sr: raise ValueError('ACTUAL_24S_PAIR_REQUIRED')
    # Generated Cues usually fade out over their last second; a cut at the
    # final frame then fails the level-step gate. Measure a 3s single-bass-owner
    # crossfade through that fade first, and keep the measured cut as fallback.
    n=3*sr
    crossfade={'type':'measured-overlap-crossfade','entryFrame':n//2,'exitFrame':len(a)-n//2,'overlapFrames':n,
      'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':dsp.bass_curves(n,sr)}
    receipt=inspect_stable_pair(dsp,current,incoming,crossfade,root/'transition.wav',request,revision=request['playbackRevision'])
    if not receipt.get('passed'):
        cut={'type':'measured-nonoverlap-cut','entryFrame':0,'exitFrame':len(a),'overlapFrames':0,
          'sampleRate':sr,'relativeIncomingGainDb':0,'eqCurves':None,'seamDeclickFrames':882}
        receipt=inspect_stable_pair(dsp,current,incoming,cut,root/'transition.wav',request,revision=request['playbackRevision'])
    return {'method':VERSION,'inputDigest':request['inputDigest'],'dspSha256':sha(args.dsp),'receipt':receipt}

def video(args,request):
    file=Path(args.directory)/'input.mp4'
    # Decode every frame; metadata-only probing cannot establish media integrity.
    proc=subprocess.run([args.ffmpeg,'-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-f','mov','-i',str(file),'-map','0:v:0','-an','-vf','format=yuv420p,signalstats,metadata=mode=print:file=-','-f','null','-'],capture_output=True,timeout=90)
    if proc.returncode: raise ValueError('FULL_VIDEO_DECODE_FAILED')
    probe=subprocess.run([args.ffprobe,'-v','error','-protocol_whitelist','file,pipe','-f','mov','-count_frames','-show_streams','-show_format','-of','json',str(file)],capture_output=True,check=True,timeout=30)
    info=json.loads(probe.stdout);streams=[s for s in info['streams'] if s['codec_type']=='video']
    if len(streams)!=1: raise ValueError('ONE_VIDEO_STREAM_REQUIRED')
    s=streams[0];count=int(s.get('nb_read_frames',0));duration=float(s.get('duration',info.get('format',{}).get('duration',0)))
    if count<1 or not math.isfinite(duration) or duration<=0: raise ValueError('VIDEO_FRAMES_REQUIRED')
    text=proc.stdout.decode('utf8',errors='strict')
    averages=[float(x)/255 for x in re.findall(r'lavfi.signalstats.YAVG=([0-9.eE+-]+)',text)]
    differences=[float(x)/255 for x in re.findall(r'lavfi.signalstats.YDIF=([0-9.eE+-]+)',text)]
    times=[float(x) for x in re.findall(r'pts_time:([0-9.eE+-]+)',text)]
    if len(averages)!=count or len(differences)!=count or len(times)!=count: raise ValueError('FULL_FRAME_STATS_REQUIRED')
    jumps=[times[i] for i in range(1,count) if abs(averages[i]-averages[i-1])>.25]
    maximum=max([sum(t-1 < x <= t for x in jumps) for t in jumps]+[0])
    # yuv420p commonly uses limited-range luma (black16, white235). These
    # thresholds also include full-range black/white; do not test only 0/255.
    stats={'method':'full-frame-luma-motion-v1','frames':count,'nearBlackFraction':sum(x<.08 for x in averages)/count,
      'nearWhiteFraction':sum(x>.90 for x in averages)/count,'meanMotion':sum(differences[1:])/max(1,count-1),
      'maximumLargeLumaTransitionsPerSecond':maximum}
    return {'method':VERSION,'inputDigest':request['inputDigest'],'rawSha256':sha(file),'fullyDecoded':True,'decodedFrames':count,'technicalStats':stats,
      'width':int(s['width']),'height':int(s['height']),'durationSeconds':duration,'hasAudioTrack':any(t['codec_type']=='audio' for t in info['streams']),
      'displayRotation':s.get('tags',{}).get('rotate','0')}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--dsp');p.add_argument('--ffmpeg',default='ffmpeg');p.add_argument('--ffprobe',default='ffprobe');a=p.parse_args()
    request=json.loads((Path(a.directory)/'request.json').read_text())
    try:
        out=audio(a,request) if request['channel']=='music' else join(a,request) if request['channel']=='join' else video(a,request)
        out['workerSha256']=sha(__file__)
        print(json.dumps(out,allow_nan=False,separators=(',',':')))
    except Exception as e:
        # Do not return local file paths, captured stderr, URLs or caller secrets.
        print(json.dumps({'status':'HOLD','reason':type(e).__name__}));raise SystemExit(2)
