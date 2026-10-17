import {createOidcOwnerVerifier,createFalKeyOwnerVerifier} from './owner-verifier.mjs';import {createPostgresRepository} from './postgres-repository.mjs';import {createPrivateObjectStore} from './private-object-store.mjs';import {createDurablePublicRuntime} from './durable-public-runtime.mjs';import {ConnectionError} from '../connection/fal-contract.mjs';
// Configuration is explicit. No env/keychain/FAL_KEY lookup or cloud provisioning.
export async function createConfiguredPublicRuntime({origin,oidc,database,storage,enabled=false,firstTrackAllowed=false,repository=null,objects=null,authenticate=null,target='serverless',fetchImpl,transportIsSecure,ownerAuthMode='fal-key'}={}){
 if(!['fal-key','external-verified'].includes(ownerAuthMode))throw new ConnectionError('OWNER_AUTH_MODE_REQUIRED');const owner=authenticate??(ownerAuthMode==='fal-key'?createFalKeyOwnerVerifier():createOidcOwnerVerifier(oidc));const repo=repository??createPostgresRepository(database);const blobs=objects??createPrivateObjectStore(storage);
 if(target==='serverless'&&(repo.kind!=='postgres'||blobs.kind!=='private-s3'))throw new ConnectionError('CLOUD_DURABLE_DEPENDENCIES_REQUIRED');if(!['local','serverless'].includes(target))throw new ConnectionError('TARGET_REQUIRED');
 if(target==='serverless'&&enabled&&blobs.privateReady!==true)throw new ConnectionError('PRIVATE_BUCKET_CHECK_REQUIRED');
 // DDL migration is separately invoked by the owner; startup does not alter a database.
 return createDurablePublicRuntime({origin,authenticate:owner,repository:repo,objects:blobs,enabled,firstTrackAllowed,ownerAuthMode,...(fetchImpl?{fetchImpl}:{}),...(transportIsSecure?{transportIsSecure}:{})});
}
