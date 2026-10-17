import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {createProductionNativeHost} from './production-host.mjs';
import {createPinnedPgPoolFactory} from './production-io.mjs';

// Explicit operator entry; importing this file never binds a port or reads a
// config. Secrets are supplied by approved ephemeral resolver functions in the
// mounted host module. No .env discovery, key printout or credential persistence.
export async function startProductionNodeServer({activated=false,configuration,hostname='127.0.0.1',port=8080}={}) {
  if(!activated||!configuration||!Number.isSafeInteger(port)||port<1||port>65535||!['127.0.0.1','0.0.0.0'].includes(hostname))
    throw Error('EXPLICIT_PRODUCTION_ACTIVATION_REQUIRED');
  const host=createProductionNativeHost({...configuration,enabled:true,createPool:configuration.createPool??(configuration.edgeTransport?undefined:
    createPinnedPgPoolFactory({readConnection:configuration.readConnection}))});
  const origin=configuration.origin??'https://ai-vdj.vercel.app';
  const server=createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:16384},async(req,res)=>{
    try {
      const parts=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('BODY_LIMIT');parts.push(chunk);}
      const request=new Request(new URL(req.url,origin),{method:req.method,headers:new Headers(req.headers),
        ...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(parts)})});
      const response=await host.handleRequest(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body){const reader=response.body.getReader();try{for(;;){const part=await reader.read();if(part.done)break;
        if(!res.write(Buffer.from(part.value)))await new Promise((resolve,reject)=>{res.once('drain',resolve);res.once('error',reject);});}}
        finally{await reader.cancel().catch(()=>{});}}
      res.end();
    }catch{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"PRODUCTION_HOST_HOLD"}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,resolve);});
  try{await host.start();}catch{await new Promise(resolve=>server.close(resolve));await host.close();throw Error('PRODUCTION_HOST_START_HOLD');}
  return {host,server,async close(){server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));await host.close();}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const path=process.argv.find(v=>v.startsWith('--host-config='))?.slice('--host-config='.length);
  if(!process.argv.includes('--activate')||!path)throw Error('EXPLICIT_PRODUCTION_ACTIVATION_REQUIRED');
  // This is a trusted operator module, not uploaded code or browser input.
  const configuration=(await import(pathToFileURL(path).href)).default;
  const instance=await startProductionNodeServer({activated:true,configuration,
    hostname:configuration.hostname??'127.0.0.1',port:configuration.port??8080});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void instance.close().then(()=>process.exit(0),()=>process.exit(1));});
}
