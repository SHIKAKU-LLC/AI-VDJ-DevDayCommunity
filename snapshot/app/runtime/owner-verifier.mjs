import {jwtVerify,createRemoteJWKSet} from 'jose';
import {createHash} from 'node:crypto';
import {ConnectionError,suppliedKey} from '../connection/fal-contract.mjs';
// BYOK-only identity. Upstream authentication must be verified by explicit validate.
// The irreversible owner identifier is metadata, not a transferable fal credential.
export function createFalKeyOwnerVerifier(){return async req=>createHash('sha256').update('ai-vdj-byok-owner-v1\0'+suppliedKey(req)).digest('hex');}
// Trusted issuer settings are server configuration, never supplied by a request.
export function createOidcOwnerVerifier({issuer,audience,jwksUrl,resolver=null,now=null}={}){
 let i,j;try{i=new URL(issuer);j=new URL(jwksUrl);}catch{throw new ConnectionError('OIDC_CONFIG_REQUIRED');}if(i.protocol!=='https:'||j.protocol!=='https:'||i.username||i.password||j.username||j.password||!audience)throw new ConnectionError('OIDC_CONFIG_REQUIRED');
 const keys=resolver??createRemoteJWKSet(j,{timeoutDuration:5000,cooldownDuration:30000});
 return async req=>{const h=req.headers.authorization;if(typeof h!=='string'||! /^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(h))throw new ConnectionError('OWNER_LOGIN_REQUIRED');try{const {payload}=await jwtVerify(h.slice(7),keys,{issuer,audience,algorithms:['RS256','ES256','EdDSA'],requiredClaims:['sub','iat','exp'],maxTokenAge:'1h',clockTolerance:5,...(now?{currentDate:new Date(now())}:{})});if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>256)throw Error();return createHash('sha256').update(issuer+'\0'+payload.sub).digest('hex');}catch{throw new ConnectionError('OWNER_LOGIN_REQUIRED');}};
}
