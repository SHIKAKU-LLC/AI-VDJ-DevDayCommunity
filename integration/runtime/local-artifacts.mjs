import {mkdtemp, mkdir, realpath, access, readFile, writeFile, unlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const kinds = new Set(['audio/wav','video/mp4','image/png','image/jpeg','application/json']);
const assetId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export async function createLocalArtifactStore({directory, maximumBytes = 256 * 1024 * 1024} = {}) {
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>256*1024*1024)throw Error('BOUNDED_STORAGE_QUOTA_REQUIRED');
  const owned = !directory;
  directory ??= await mkdtemp(path.join(tmpdir(),'vdj-private-artifacts-'));
  await mkdir(directory,{recursive:true,mode:0o700}); directory = await realpath(directory);
  for (let p=directory;;p=path.dirname(p)) {
    try { await access(path.join(p,'.git')); throw Error('MEDIA_MUST_REMAIN_OUTSIDE_GIT'); }
    catch (e) { if (e.message === 'MEDIA_MUST_REMAIN_OUTSIDE_GIT') throw e; if (e.code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
  const records = new Map(); let used = 0, serial = Promise.resolve();
  const atomic = fn => { const result = serial.then(fn); serial = result.catch(()=>{}); return result; };
  return {
    kind:'private-local',
    save({bytes,contentType,binding,provenance={},id=randomUUID()}) {
      return atomic(async()=>{
        if (!assetId(id) || !kinds.has(contentType) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length>32*1024*1024)
          throw Error('BOUNDED_PRIVATE_ASSET_REQUIRED');
        const data=Buffer.from(bytes), fingerprint=sha(data), prior=records.get(id);
        if (prior) { if(prior.sha256!==fingerprint||JSON.stringify(prior.binding)!==JSON.stringify(binding))throw Error('ASSET_IMMUTABLE'); return {...prior}; }
        if (used+data.length>maximumBytes) throw Error('PRIVATE_STORAGE_QUOTA');
        const record={assetId:id,sha256:fingerprint,byteLength:data.length,contentType,binding:structuredClone(binding),
          provenance:Object.fromEntries(['kind','requestId','resultSha256','modelId','generationId','contextSha256','operationId'].filter(k=>k in provenance).map(k=>[k,provenance[k]]))};
        let written=false;
        try { await writeFile(path.join(directory,id+'.blob'),data,{flag:'wx',mode:0o600});written=true;
          await writeFile(path.join(directory,id+'.json'),JSON.stringify(record),{flag:'wx',mode:0o600}); }
        catch(e){if(written)await unlink(path.join(directory,id+'.blob')).catch(()=>{});throw e;}
        records.set(id,record);used+=data.length;return structuredClone(record);
      });
    },
    async read(id) {
      await serial;const record=records.get(id);if(!record)throw Error('PRIVATE_ASSET_REQUIRED');
      const bytes=await readFile(path.join(directory,id+'.blob'));
      if(bytes.length!==record.byteLength||sha(bytes)!==record.sha256)throw Error('PRIVATE_ASSET_CHANGED');
      return {...structuredClone(record),bytes};
    },
    async verifySaved({binding,asset}) {
      const record=await this.read(asset.assetId);
      if(record.sha256!==asset.sha256||JSON.stringify(record.binding)!==JSON.stringify(binding))throw Error('PRIVATE_BINDING_MISMATCH');
      return {privateSaved:true,checksumVerified:true,binding:record.binding,assetId:record.assetId,sha256:record.sha256};
    },
    usage:()=>({bytes:used,maximumBytes,assets:records.size}),
    async close(){await serial;if(owned)await rm(directory,{recursive:true,force:true});records.clear();used=0;},
  };
}
