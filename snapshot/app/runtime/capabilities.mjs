export const PROCESSING_CAPABILITIES=Object.freeze({
 browser:{playback:true,rawPulse:true,onsetAnalysis:true,canvas16x9:true,separateOutput:true,localFilesystem:false,keychain:false},
 local:{seedContext:true,activityQC:true,mixedPCM:true,ffmpegQC:true,filesystemLedger:true,keychainHumanRunner:true},
 serverless:{requestScopedFalAuth:true,queuePort:true,pinnedSDK:true,proxyHandler:true,storageInitiate:true,directBrowserUpload:true,initialTrackQueueAndBrowserQC:true,privateLocalWorkers:false,keychain:false,productionJobStore:false,mediaStorage:false,firstTrackInLocalDSP:false,productionReady:false},
});
