"""Verify complete saved origins against the four prepared24s samples."""
from pathlib import Path
import argparse,json,hashlib
import numpy as np,soundfile as sf
ROOT=Path(__file__).resolve().parent.parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):
 if p.suffix=='.pcm':return np.frombuffer(p.read_bytes(),dtype='<i2').reshape(-1,2).astype(float)/32768
 return sf.read(p,always_2d=True,dtype='float64')[0]
def prepare(out):
 out=Path(out)
 if out.exists():raise ValueError('NEW_OUTPUT_DIRECTORY_REQUIRED')
 base=ROOT/'app/connection/cross-track-20261013/run-02';old=json.loads((base/'evaluation.json').read_text());comp=json.loads((ROOT/'vnext/eye-review/composition.json').read_text())['audio']
 origin_info=json.loads((ROOT/'app/connection/actual-room-20261013/catalog.json').read_text())['sourceProvenance']
 origins={'current':ROOT/'app/connection/actual-room-20261013/origin-verified.wav','music-B':Path(comp['sourcePath']),'variant-A':ROOT/'vnext/live/runtime/live-abc-03/A/rendered-stream.pcm','variant-C':ROOT/'vnext/live/runtime/live-abc-03/C/rendered-stream.pcm'}
 expected={'current':origin_info['originSha256'],'music-B':comp['sourceSha256'],'variant-A':old['sources']['variant-A']['sourceOriginSha256'],'variant-C':old['sources']['variant-C']['sourceOriginSha256']}
 offsets={'current':0,'music-B':round(comp['sourceStartSeconds']*44100),'variant-A':8*44100,'variant-C':8*44100};rows=[];sources={}
 for name,origin in origins.items():
  if sha(origin)!=expected[name]:raise ValueError('SOURCE_ORIGIN_CHANGED: '+name)
  x=read(origin);clip=base/old['sources'][name]['file'];prepared=sf.read(clip,always_2d=True,dtype='float32')[0];gain=old['sources'][name]['preparation'].get('gainDb',0);i=offsets[name]
  actual=(x[i:i+len(prepared)]*10**(gain/20)).astype('float32')
  if not np.array_equal(prepared,actual):raise ValueError('SOURCE_RANGE_NOT_EXACT: '+name)
  rows.append({'name':name,'originPath':str(origin),'originSha256':sha(origin),'originFrames':len(x),'preparedSha256':sha(clip),'startFrame':i,'frameCount':len(prepared),'gainDb':gain,'exactPreparedSamplesVerified':True,'preparedPcmSha256':hashlib.sha256(prepared.astype('<f4').tobytes()).hexdigest()});sources[name]={'file':str(origin)}
 out.mkdir(parents=True);(out/'context-map.json').write_text(json.dumps({'sources':rows,'musicBMetadataGainIgnored':comp.get('gain'),'proof':'Use directly verified PCM mapping and actual preparation gain; old visual metadata gain is not applied.'},indent=2)+'\n');(out/'catalog.json').write_text(json.dumps({'sources':sources},indent=2)+'\n')
 print('verified full origins',[(r['name'],r['originFrames']/44100) for r in rows])
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',required=True);prepare(p.parse_args().out)
