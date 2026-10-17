import {pcmSha256} from './playback/cue-contract.mjs';

// Transport functions are supplied by the authenticated local owner host.
// Nothing is fetched from an arbitrary URL in a cue or participant prompt.
export function createPrivateMediaResolver({readArtifact,readRender,urlAPI=globalThis.URL}={}){
  if(typeof readArtifact!=='function'||typeof readRender!=='function')throw Error('PRIVATE_RESOLVER_REQUIRED');
  const prepared=new WeakMap();
  return {
    async resolveMedia(input){
      const {cue,plan,signal}=input,render=await readRender(input);
      if(signal?.aborted)throw Error('MEDIA_RESOLUTION_STOPPED');
      if(!(render?.pcm instanceof Float32Array)||render.sampleRate!==44100||render.renderedFileSha256!==plan.transition.renderedSha256||
         render.renderedPcmSha256!==await pcmSha256(render.pcm))throw Error('VERIFIED_RENDER_REQUIRED');
      const videos=[],urls=[];
      try{
        for(const clip of cue.video.clips){
          const result=await readArtifact({roomId:input.roomId,assetId:clip.assetId,signal});
          if(signal?.aborted)throw Error('MEDIA_RESOLUTION_STOPPED');
          const bytes=result?.bytes;
          if(!(bytes instanceof Uint8Array)||bytes.byteLength>32*1024*1024||result.contentType!=='video/mp4'||
             await pcmSha256(bytes)!==clip.sha256)throw Error('PRIVATE_VIDEO_HASH_MISMATCH');
          const url=urlAPI.createObjectURL(new Blob([bytes],{type:'video/mp4'}));urls.push(url);
          videos.push({assetId:clip.assetId,sha256:clip.sha256,url,source:result.provenance?.kind==='provider'?'fal':'local-edit',
            requestId:result.provenance?.requestId??'saved-'+clip.assetId});
        }
        const audio={assetId:cue.music.asset.assetId,sha256:cue.music.asset.sha256,renderedPcmSha256:render.renderedPcmSha256};
        prepared.set(audio,render);
        return {audio,videos,release(){prepared.delete(audio);for(const url of urls)urlAPI.revokeObjectURL(url);}};
      }catch(e){for(const url of urls)urlAPI.revokeObjectURL(url);throw e;}
    },
    async loadVerifiedRender({media,signal}){
      const value=prepared.get(media);if(!value||signal?.aborted)throw Error('PRIVATE_RENDER_NOT_PREPARED');
      return value;
    },
  };
}
