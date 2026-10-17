// Permission-free Deno/Node fixture: generated test key, no account, env, file,
// network, Keychain, platform or DB access. Never print signatures/key material.
import {createRuntimeRequestSigner,createRuntimeRequestVerifier} from '../cloud/room/runtime-request-proof.mjs';
const scope={roomId:'11111111-1111-4111-a111-111111111111',['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,expiresAtMs:Date.now()+10000};
const signer=await createRuntimeRequestSigner({enabled:true,scope}),record={...signer.registration(),approved:true};
const path='/api/rooms/'+scope.roomId+'/runtime/query',body=new TextEncoder().encode('{}'),owner='a'.repeat(64);
const headers=await signer.sign({path,body,ownerCapability:owner,contentType:'application/json'});
const request=new Request('https://ai-vdj.vercel.app'+path,{method:'POST',headers:{...headers,'x-room-owner':owner,'content-type':'application/json'}});
const result=await createRuntimeRequestVerifier({enabled:true,readApprovedWorker:async()=>record})({request,body,roomId:scope.roomId});
if(result.roomId!==scope.roomId||Object.hasOwn(record.publicJwk,'d'))throw Error('SYNTHETIC_EDGE_PROOF_FAILED');
signer.close();console.log(JSON.stringify({fixtureOnly:true,ed25519Verified:true,privateKeyExported:false,providerCalls:0,existingSecretReads:0}));
