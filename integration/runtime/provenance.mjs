import {randomUUID, createHash} from 'node:crypto';
import {GENERATION_CONTRACT} from '../../cloud/generation/dispatch.mjs';
import {operationBinding} from '../../cloud/generation/cue-contract.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
// Lives in the authenticated owner runner. Receipt handles are not provenance
// assertions: every check re-reads the immutable provider operation ledger.
export function createOperationProvenance({readOperation,readSavedRecord,fetchImpl=globalThis.fetch}={}) {
  if(typeof readOperation!=='function')throw Error('TRUSTED_OPERATION_READER_REQUIRED');
  const receipts=new Map();
  async function descriptor(roomId,operationId,channel){
    const op=await readOperation({roomId,operationId});
    if(!['music','video'].includes(channel)||op?.operationId!==operationId||op.stages?.[channel]?.state!=='COMPLETE')
      throw Error('COMPLETED_PROVIDER_STAGE_REQUIRED');
    const stage=op.stages[channel],binding=operationBinding(roomId,op,channel);
    const sourceSha256=channel==='music'?op.permit.source.music.contextSha256:op.permit.source.video.referenceSha256;
    return {op,stage,binding,sourceSha256};
  }
  return {
    async download({roomId,operationId,channel,signal}) {
      const {stage,binding,sourceSha256}=await descriptor(roomId,operationId,channel);
      const url=new URL(stage.result.url);
      if(url.protocol!=='https:'||url.username||url.password||!/(^|\.)fal\.media$/.test(url.hostname))throw Error('PROVIDER_MEDIA_TARGET_REQUIRED');
      const response=await fetchImpl(url.href,{credentials:'omit',redirect:'error',signal});
      if(!response.ok||response.redirected)throw Error('PROVIDER_DOWNLOAD_FAILED');
      const declared=Number(response.headers.get('content-length')??0),maximum=32*1024*1024;
      if(declared>maximum)throw Error('PROVIDER_MEDIA_TOO_LARGE');
      const reader=response.body.getReader(),parts=[];let size=0;
      while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
        if(size>maximum){await reader.cancel();throw Error('PROVIDER_MEDIA_TOO_LARGE');}parts.push(part.value);}
      if(!size)throw Error('PROVIDER_MEDIA_EMPTY');
      const bytes=Buffer.concat(parts.map(p=>Buffer.from(p))),id=randomUUID();
      const receipt={kind:'provider',verified:true,binding,rawSha256:hash(bytes),byteLength:size,sourceSha256,
        requestId:stage.requestId,operationId,resultSha256:stage.result.resultSha256,modelId:GENERATION_CONTRACT[channel]};
      receipts.set(id,{roomId,channel,receipt});
      return{bytes,sha256:receipt.rawSha256,provenance:{receiptId:id}};
    },
    async verifyProvenance(handle,request){
      const known=receipts.get(handle?.receiptId);
      if(known){
        const current=await descriptor(known.roomId,known.receipt.operationId,known.channel),r=known.receipt;
        if(cueDigest(current.binding)!==cueDigest(request.binding)||current.stage.requestId!==r.requestId||
          current.stage.result.resultSha256!==r.resultSha256||current.sourceSha256!==r.sourceSha256||
          request.rawSha256!==r.rawSha256||request.byteLength!==r.byteLength||request.sourceSha256!==r.sourceSha256)return null;
        return structuredClone(r);
      }
      if(['saved','owner-supplied-bootstrap-video'].includes(handle?.kind)&&typeof readSavedRecord==='function'){
        const record=await readSavedRecord(handle.assetId,structuredClone(request));
        if(record?.sha256!==request.rawSha256||record.byteLength!==request.byteLength||
          record.referenceSha256!==request.sourceSha256||!record.binding)return null;
        if(handle.kind==='owner-supplied-bootstrap-video'){
          if(record.kind!==handle.kind||record.actualGenerationThisRun!==false||record.generationId!==undefined||
            record.binding.kind!==handle.kind||record.binding.roomId!==request.binding?.roomId||request.binding?.channel!=='video'||
            !id(record.admissionId)||!sha(record.admissionEvidenceSha256))return null;
          return {kind:handle.kind,verified:true,binding:request.binding,rawSha256:record.sha256,byteLength:record.byteLength,
            sourceSha256:record.referenceSha256,admissionId:record.admissionId,admissionEvidenceSha256:record.admissionEvidenceSha256,
            originalBindingSha256:cueDigest(record.binding),actualGenerationThisRun:false};
        }
        if(!record.generationId||record.kind==='owner-supplied-bootstrap-video')return null;
        return {kind:'saved',verified:true,binding:request.binding,rawSha256:record.sha256,byteLength:record.byteLength,
          sourceSha256:record.referenceSha256,originalGenerationId:record.generationId,originalBindingSha256:cueDigest(record.binding)};
      }
      return null;
    },
    close(){receipts.clear();},
  };
}
