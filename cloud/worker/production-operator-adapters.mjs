import {createFalPlatformAdapter,createFalQuoteAndBalance} from './fal-platform-adapter.mjs';
import {createOperatorConnections} from './operator-connections.mjs';
import {createOperatorSourceSigner,createSavedVideoResolver} from './operator-source-adapters.mjs';
import {adapterFail} from './operator-adapter-error.mjs';
// Default-off composition. The approved host injects the custodian and fresh
// safety/unit evidence; this module chooses no secret storage or billing role.
export function createProductionOperatorAdapters({enabled=false,configuration={},readScope,readOperation,readConnectionBinding,readCurrentSource,
 readPreparationSource,readBootstrapAuthority,bootstrapConfiguration,privateStore,fetchImpl=globalThis.fetch,now=Date.now}={}){
 if(typeof enabled!=='boolean')adapterFail('OPERATOR_ADAPTER_CONFIGURATION_REQUIRED');
 if(!enabled){configuration={};privateStore=undefined;}
 const platform=createFalPlatformAdapter({enabled,fetchImpl,now});
 const connections=createOperatorConnections({enabled,platform,custodian:configuration.custodian,readScope,readConnectionBinding,now});
 const quote=createFalQuoteAndBalance({enabled,platform,connections,readSafetyApproval:configuration.readSafetyApproval,balanceMode:configuration.balanceMode??'api',now});
 const quoteAndBalance=async input=>{try{return await quote(input);}catch(e){if(e.code==='OPERATOR_CONNECTION_REQUIRED')adapterFail(e.code);adapterFail(e.code==='FAL_PLATFORM_PERMISSION_REQUIRED'?'OPERATOR_BILLING_PERMISSION_REQUIRED':
  ['FAL_SAFETY_APPROVAL_REQUIRED','FAL_MANUAL_BALANCE_REQUIRED'].includes(e.code)?'OPERATOR_OPERATIONAL_APPROVAL_REQUIRED':'OPERATOR_PRICE_APPROVAL_REQUIRED');}};
 const signSource=createOperatorSourceSigner({enabled,privateStore,readScope,readCurrentSource,readPreparationSource,readBootstrapAuthority,bootstrapConfiguration,now});
 const providerVideo=createSavedVideoResolver({enabled,assetStore:privateStore?.assetStore,receiptStore:privateStore?.receiptStore,readOperation,readScope,
  approvedAssetIds:configuration.approvedVideoAssetIds??[]});
 const ownerBootstrapVideoApproved=configuration.ownerBootstrapVideoApproved===true;
 // A known provider asset always follows its receipt resolver. Missing or
 // damaged receipts never downgrade that asset to owner-supplied material.
 const verifySavedVideo=async input=>{
  if(!ownerBootstrapVideoApproved)return providerVideo(input);
  for(const assetId of configuration.approvedVideoAssetIds??[]){
   const record=await privateStore.assetStore.read(assetId);
   if(record.sha256===input.sha256)return providerVideo(input);
  }
  return null;
 };
 return Object.freeze({connections,quoteAndBalance,signSource,verifySavedVideo,ownerBootstrapVideoApproved,
  close(){connections.close();platform.close();},capabilities:()=>({enabled,connectionReady:connections.capabilities().ready,
    mediaReady:ownerBootstrapVideoApproved||(configuration.approvedVideoAssetIds?.length??0)>0,trialReady:typeof configuration.readSafetyApproval==='function',
    balanceApi:true,autoTopUpApi:false,credentialStorageSelected:false})});
}
