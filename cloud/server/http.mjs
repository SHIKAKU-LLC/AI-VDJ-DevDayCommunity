import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
export async function startJudgeHttpServer({service,origin,port=8080,hostname='127.0.0.1'}={}){
 const server=createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:16384},async(req,res)=>{
  try{
   let size=0;const parts=[];
   for await(const part of req){size+=part.length;if(size>65536){res.writeHead(413);res.end();return;}parts.push(part);}
   const body=Buffer.concat(parts),request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,
    ...(['GET','HEAD'].includes(req.method)?{}:{body})});
   const result=await service.handleRequest(request);
   res.writeHead(result.status,Object.fromEntries(result.headers));
   if(result.body)await pipeline(Readable.fromWeb(result.body),res);else res.end();
  }catch{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"JUDGE_BACKEND_HOLD"}');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,resolve);});
 return {server,async close(){server.closeIdleConnections?.();await service.close();await new Promise(resolve=>server.close(resolve));}};
}
