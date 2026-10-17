import {readCompanionConfiguration,readPrivateCompanionJson} from './companion-config.mjs';
import {createMacCompanionDeviceStore} from './companion-device-store.mjs';
import {createMacCompanionRuntime} from './companion-runtime.mjs';
import {createMacHost} from './server.mjs';
import {spawn} from 'node:child_process';
import {writeFileSync, renameSync} from 'node:fs';
import {createOwnerCloudConnection} from '../runtime/owner-cloud-connection.mjs';
import {readApprovedBootstrap} from './approved-bootstrap.mjs';
import {readEdgeTrialManifest,createEdgeTrialApprovalFiles} from './edge-trial-launch.mjs';
import {readNativeQcOptions,createLaunchBootstrapPreparer} from './native-qc-options.mjs';

// Operator-run entrypoint only. No service registration, shell, firewall or VPN changes.
const args = process.argv.slice(2);
const qcOptions=readNativeQcOptions();
const localBootstrap=createLaunchBootstrapPreparer({options:qcOptions});
const diagnostics=[];
const record=(event,reason=null)=>{
  diagnostics.push({event,reason,timeMs:Date.now(),pid:process.pid,parentPid:process.ppid});
  if(diagnostics.length>64)diagnostics.shift();
  if(process.env.VDJ_MAC_STATUS_FILE)try{
    const temp=process.env.VDJ_MAC_STATUS_FILE+'.next';
    writeFileSync(temp,JSON.stringify(diagnostics),{mode:0o600});renameSync(temp,process.env.VDJ_MAC_STATUS_FILE);
  }catch{}
};
if (args.length < 1 || args.length > 2) throw Error('USAGE: node integration/mac-host/launch.mjs ROOM_ID [EXACT_HTTPS_ORIGIN]');
const companionFile=process.env.VDJ_MAC_COMPANION_CONFIG;
if(Object.hasOwn(process.env,'VDJ_MAC_COMPANION_CONFIG')&&!companionFile)throw Error('COMPANION_NATIVE_CONFIGURATION_REQUIRED');
const companion=companionFile?await readCompanionConfiguration(companionFile):null;
if(companion&&(args[0]!==companion.roomId||args.length===2&&args[1]!==companion.cloudOrigin))throw Error('COMPANION_SCOPE_REQUIRED');
const deviceStore=companion?createMacCompanionDeviceStore({enabled:true,helperPath:companion.helperPath,helperSha256:companion.helperSha256}):null;
const writePrivateMetadata=async(file,record)=>{
 const {open}=await import('node:fs/promises');
 const flags=(await import('node:fs')).constants;
 let h;try{h=await open(file,flags.O_WRONLY|flags.O_CREAT|flags.O_NOFOLLOW,0o600);const stat=await h.stat();
  if(!stat.isFile()||(stat.mode&0o777)!==0o600||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error();
  await h.truncate(0);await h.writeFile(JSON.stringify(record));await h.sync();
 }catch{throw Error('COMPANION_PUBLIC_METADATA_HOLD');}finally{await h?.close();}
};
const trialFile = process.env.VDJ_MAC_EDGE_TRIAL_MANIFEST;
if(companion&&trialFile)throw Error('COMPANION_OR_TRIAL_REQUIRED');
if (Object.hasOwn(process.env,'VDJ_MAC_EDGE_TRIAL_MANIFEST') && !trialFile) throw Error('EDGE_TRIAL_PATH_REQUIRED');
const trial = trialFile ? await readEdgeTrialManifest(trialFile) : null;
if (trial && (args[0] !== trial.roomId || args.length === 2 && args[1] !== trial.cloudOrigin))
  throw Error('EDGE_TRIAL_LAUNCH_SCOPE_REQUIRED');
const trialRemainingMs = trial ? trial.expiresAtMs - Date.now() : 0;
if (trial && trialRemainingMs < 1000) throw Error('EDGE_TRIAL_WINDOW_REQUIRED');
const approvalFiles = trial ? createEdgeTrialApprovalFiles(trial) : null;
const createMacEdgeTrialRuntime = trial ? (await import('./edge-trial-composition.mjs')).createMacEdgeTrialRuntime : null;
const nativeOrchestrator = trial?.mode === 'prepare' ? await import('./edge-trial-native-orchestrator.mjs') : null;
const operatorModule = trial ? await import('./edge-trial-operator-config.mjs') : null;
const readOperationalApproval = trial ? scope => {
  if(!trial.operationalApprovalFile)throw Error('EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED');
  return operatorModule.readEdgeTrialOperationalApprovalFile({file:trial.operationalApprovalFile,
    roomId:trial.roomId,expiresAtMs:trial.expiresAtMs,scope});
} : null;
const host = await createMacHost({roomId: args[0], cloudOrigin: trial?.cloudOrigin ?? args[1] ?? 'https://ai-vdj.vercel.app',
 port:Number(process.env.VDJ_MAC_PORT??54414),companionMode:!trial,
 ...(companion?{enableProductionRoutes:true,companionRuntimeApproved:true,consentStore:deviceStore}:{}),
 ...(trial ? {expiresAtMs:trial.expiresAtMs,lifetimeMs:Math.min(30*60_000,trialRemainingMs),
  enableProductionRoutes:true} : {}),
 onDiagnostic:event=>record(event.event,event.reason),
 prepare:localBootstrap.prepare,
 loadBootstrap:process.env.VDJ_MAC_BOOTSTRAP_FILE?()=>readApprovedBootstrap(process.env.VDJ_MAC_BOOTSTRAP_FILE,
  {prepare:localBootstrap.prepare}):undefined,
 createRuntime:context=>{
  if(companion)return createMacCompanionRuntime({...context,projectURL:companion.projectURL,deviceStore,policy:companion,
    configuration:{runtime:qcOptions},onDiagnostic:event=>record(event.event,event.reason),readOperationalApproval:()=>readPrivateCompanionJson(companion.operationalApprovalFile),
    writeRegistration:(identity,registration)=>writePrivateMetadata(companion.registrationFile,{identity,registration}),
    writeMetadata:metadata=>writePrivateMetadata(companion.registrationFile+'.provider-metadata.json',metadata)});
  if(!trial)return createOwnerCloudConnection({roomId:context.roomId,signal:context.signal});
  const expiresAtMs=Math.min(trial.expiresAtMs,context.sessionExpiresAtMs);
  const configuration={runtime:qcOptions,operatorConfiguration:operatorModule.buildEdgeTrialOperatorConfiguration({
    readOperationalApproval,roomId:trial.roomId,expiresAtMs})};
  const runtime=createMacEdgeTrialRuntime({...context,projectURL:trial.projectURL,enabled:trial.enabled,expiresAtMs,
    configuration,writeRegistration:approvalFiles.writeRegistration,readActivation:approvalFiles.readActivation,
    readOperationalConfiguration:registration=>operatorModule.readEdgeTrialConfiguration({
      readOperationalApproval,registration,roomId:trial.roomId,expiresAtMs})});
  return nativeOrchestrator?.createEdgeTrialNativeOrchestrator({runtime,roomId:trial.roomId,expiresAtMs,
    readActivation:approvalFiles.readActivation,readCurrent:context.readCurrent,
    readOperationalConfiguration:registration=>operatorModule.readEdgeTrialConfiguration({
      readOperationalApproval,registration,roomId:trial.roomId,expiresAtMs}),
    writeMetadata:nativeOrchestrator.createPrivateMetadataWriter({activationFile:trial.activationFile})})??runtime;
 }});
let stopping=false;
async function stop(reason,code=0){if(stopping)return;stopping=true;record('PROCESS_STOPPING',reason);deviceStore?.close();await host.close().catch(()=>{});await localBootstrap.close().catch(()=>{});process.exit(code);}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.once(signal,()=>{void stop(signal);});
process.once('uncaughtException',()=>{record('PROCESS_ERROR','UNCAUGHT_EXCEPTION');void stop('UNCAUGHT_EXCEPTION',1);});
process.once('unhandledRejection',()=>{record('PROCESS_ERROR','UNHANDLED_REJECTION');void stop('UNHANDLED_REJECTION',1);});
process.once('exit',code=>record('PROCESS_EXIT',String(code)));
process.once('disconnect',()=>record('LAUNCHER_RELEASED'));
// The trial's immutable deadline bounds the entire process and every session.
const maxAge=trial?setTimeout(()=>{void stop('HOST_MAX_AGE');},
  Math.min(4*60*60_000,Math.max(1,trial.expiresAtMs-Date.now()))):null;maxAge?.unref();
try {
  const {origin} = await host.listen();
  record('LISTENING');
  process.send?.({type:'ready',pid:process.pid,origin});
  if(process.env.VDJ_MAC_NO_OPEN!=='1' && trial?.mode!=='dormant'){
    const child = spawn('/usr/bin/open', [trial?origin:(args[1]??'https://ai-vdj.vercel.app')+'/room'], {stdio: 'ignore'});
    child.on('error', () => { void host.close(); });
  }
  // Never follow the local code with an automatic cloud dialog. The local
  // pairing must finish first; cloud pairing is an explicit button afterward.
  // Ordinary startup waits for the authenticated owner screen. No code dialog
  // or generation starts merely because the companion process has launched.
} catch { record('PROCESS_START_FAILED');process.send?.({type:'failed'});await host.close();await localBootstrap.close().catch(()=>{});process.exitCode=1; }
