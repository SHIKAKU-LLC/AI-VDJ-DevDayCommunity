"""Render observation-derived candidate geometry; musical uncertainty stays HOLD."""
import argparse, importlib.util, json
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('dsp',ROOT/'app/runtime/dj-transition-dsp.py');dsp=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsp)

def prepare(catalog_path,observations_path,out):
    catalog_path=Path(catalog_path).resolve();observations_path=Path(observations_path).resolve();out=Path(out)
    catalog=json.loads(catalog_path.read_text());observation=json.loads(observations_path.read_text())
    if observation['sourceCatalogSha256']!=dsp.digest_file(catalog_path):raise ValueError('STALE_SOURCE_CATALOG')
    if out.exists():raise ValueError('NEW_OUTPUT_DIRECTORY_REQUIRED')
    paths={name:catalog_path.parent/s['file'] for name,s in catalog['sources'].items()}
    before={name:dsp.digest_file(p) for name,p in paths.items()}
    if any(before[n]!=observation['observations'][n]['assetSha256'] for n in paths):raise ValueError('STALE_OBSERVATIONS')
    out.mkdir(parents=True)
    pairs=[]
    for name,group in observation['pairPlans'].items():
        for i,plan in enumerate(group['plans'][:3]):
            if plan['status']!='HOLD':raise ValueError('UNVERIFIED_PLAN_PROMOTION')
            s={**plan['spec'],'eqCurves':dsp.bass_curves(plan['spec']['overlapFrames'],44100)}
            file=out/f'{name}-observed-{i+1}.wav';r=dsp.inspect_pair(paths['current'],paths[name],s,file)
            pairs.append({'incoming':name,'file':file.name,'receipt':r,'observationPlan':plan,
              'status':'HOLD','reasons':sorted(set(plan['reasons']+r['renderQC']['reasons'])),
              'observationFileSha256':dsp.digest_file(observations_path)})
            print(name,i+1,'audio',r['renderQC'],'musical HOLD',flush=True)
    after={name:dsp.digest_file(p) for name,p in paths.items()}
    if before!=after:raise ValueError('ORIGINAL_CHANGED')
    (out/'evaluation.json').write_text(json.dumps({'method':'observation-derived-render-review-v1','pairs':pairs,
      'sourceHashesBefore':before,'sourceHashesAfter':after,'allOriginalsPreserved':True,'actualAPIRequests':0,
      'automaticIndependentAdoption':False,'subjectiveListeningVerified':False},indent=2,allow_nan=False)+'\n')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--catalog',required=True);p.add_argument('--observations',required=True);p.add_argument('--out',required=True)
    a=p.parse_args();prepare(a.catalog,a.observations,a.out)
