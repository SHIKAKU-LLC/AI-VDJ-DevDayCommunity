import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createBootstrapInspector} from '../../integration/runtime/bootstrap.mjs';
import {createNativeInspectors} from '../../integration/qc/native-inspectors.mjs';
import {createNativeReferenceInspector} from './reference-inspector.mjs';

const defaultDSP=fileURLToPath(new URL('../../snapshot/app/runtime/dj-transition-dsp.py',import.meta.url));
// Existing DSP resolves ffmpeg through shutil.which. A private, hash-pinned
// import wrapper injects that path without changing global process.env/PATH.
export async function createPortableNativeRuntime({python='python3',ffmpeg='ffmpeg',ffprobe='ffprobe',
  dspModule=defaultDSP,timeoutMs=120000}={}) {
  if(![python,ffmpeg,ffprobe,dspModule].every(x=>typeof x==='string'&&x.length&& !x.includes('\0')))
    throw Error('TRUSTED_RUNTIME_PATHS_REQUIRED');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>180000)throw Error('BOUNDED_NATIVE_TIMEOUT_REQUIRED');
  const original=path.resolve(dspModule),sha=createHash('sha256').update(await readFile(original)).digest('hex');
  const directory=await mkdtemp(path.join(tmpdir(),'vdj-cloud-runtime-')),wrapper=path.join(directory,'trusted-dsp.py');
  // JSON string literals have Python-compatible syntax for these string values.
  const script=`import argparse, hashlib, importlib.util, json\nfrom pathlib import Path\n_source = ${JSON.stringify(original)}\nif hashlib.sha256(Path(_source).read_bytes()).hexdigest() != ${JSON.stringify(sha)}:\n    raise ValueError('TRUSTED_DSP_CHANGED')\n_spec = importlib.util.spec_from_file_location('portable_original_dsp', _source)\n_dsp = importlib.util.module_from_spec(_spec)\n_spec.loader.exec_module(_dsp)\n_which = _dsp.shutil.which\nclass _PortableTools:\n    @staticmethod\n    def which(name):\n        return ${JSON.stringify(ffmpeg)} if name == 'ffmpeg' else _which(name)\n_dsp.shutil = _PortableTools\nprofile = _dsp.profile\ninspect_pair = _dsp.inspect_pair\nprepare_headroom = _dsp.prepare_headroom\nbass_curves = _dsp.bass_curves\ndb = _dsp.db\nrms = _dsp.rms\ndigest_object = _dsp.digest_object\nif __name__ == '__main__':\n    p = argparse.ArgumentParser()\n    p.add_argument('--profile', required=True)\n    args = p.parse_args()\n    print(json.dumps(profile(args.profile), allow_nan=False))\n`;
  try {await writeFile(wrapper,script,{mode:0o600});}
  catch(e){await rm(directory,{recursive:true,force:true});throw e;}
  const native=createNativeInspectors({python,ffmpeg,ffprobe,dspModule:wrapper,timeoutMs});
  return {native,inspectBootstrap:createBootstrapInspector({python,dspModule:wrapper}),
    inspectReference:createNativeReferenceInspector({ffmpeg,ffprobe,timeoutMs}),
    dspSha256:sha,async close(){await rm(directory,{recursive:true,force:true});}};
}
