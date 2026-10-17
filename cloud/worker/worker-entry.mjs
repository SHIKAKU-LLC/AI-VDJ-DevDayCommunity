import {pathToFileURL} from 'node:url';
import {createProductionNativeHost} from './production-host.mjs';
import {createPinnedPgPoolFactory} from './production-io.mjs';

// Placement-neutral resident entry. No HTTP ingress, ambient config lookup,
// credential storage or service provisioning. Uses the same bounded SQL holder.
export async function startResidentWorker({activated=false,configuration}={}){
 if(activated!==true||!configuration)throw Error('EXPLICIT_WORKER_ACTIVATION_REQUIRED');
 const host=createProductionNativeHost({...configuration,enabled:true,createPool:configuration.createPool??
  createPinnedPgPoolFactory({readConnection:configuration.readConnection})});
 try{await host.start();}catch{await host.close();throw Error('RESIDENT_WORKER_START_HOLD');}
 return Object.freeze({capabilities:host.capabilities,async close(){await host.close();}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv.find(v=>v.startsWith('--host-config='))?.slice('--host-config='.length);
 if(!process.argv.includes('--activate')||!file)throw Error('EXPLICIT_WORKER_ACTIVATION_REQUIRED');
 const configuration=(await import(pathToFileURL(file).href)).default;
 const worker=await startResidentWorker({activated:true,configuration});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void worker.close().then(()=>process.exit(0),()=>process.exit(1));});
}
