import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, chmod, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {createRuntimeRequestSigner} from '../../cloud/room/runtime-request-proof.mjs';
import {EDGE_TRIAL_ROOM_ID, EDGE_TRIAL_ROOM_EXPIRES_AT, EDGE_TRIAL_PROJECT_URL, parseEdgeTrialManifest,
  readEdgeTrialManifest, createEdgeTrialApprovalFiles} from './edge-trial-launch.mjs';

const expiry = Date.parse(EDGE_TRIAL_ROOM_EXPIRES_AT);
const now = () => expiry - 20 * 60_000;
const makeManifest = activationFile => ({version:'ai-vdj-edge-trial-v1',roomId:EDGE_TRIAL_ROOM_ID,
  projectURL:EDGE_TRIAL_PROJECT_URL,cloudOrigin:'https://ai-vdj.vercel.app',
  roomExpiresAt:EDGE_TRIAL_ROOM_EXPIRES_AT,trialExpiresAt:EDGE_TRIAL_ROOM_EXPIRES_AT,
  mode:'dormant',activationFile,operationalApprovalFile:path.join(path.dirname(activationFile),'operation.json')});

test('fixed short trial accepts dormant metadata but rejects extensions and implicit preparation', async t => {
  const dir = await mkdtemp(path.join('/tmp', 'vdj-edge-manifest-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'manifest.json'), activationFile = path.join(dir,'activation.json');
  const manifest = makeManifest(activationFile);
  assert.equal(parseEdgeTrialManifest(manifest,{now}).enabled,false);
  const {operationalApprovalFile:unused,...withoutOperation}=manifest;
  assert.equal(parseEdgeTrialManifest(withoutOperation,{now}).operationalApprovalFile,null);
  await writeFile(file,JSON.stringify(manifest),{mode:0o600});
  assert.equal((await readEdgeTrialManifest(file,{now})).roomId,EDGE_TRIAL_ROOM_ID);
  await assert.rejects(readEdgeTrialManifest(file,{now:()=>expiry}),/EDGE_TRIAL_WINDOW_REQUIRED/);
  assert.throws(()=>parseEdgeTrialManifest({...manifest,unexpected:true},{now}),/EDGE_TRIAL_MANIFEST_INVALID/);
  assert.throws(()=>parseEdgeTrialManifest({...manifest,roomId:'another-room'},{now}),/EDGE_TRIAL_MANIFEST_INVALID/);
  assert.throws(()=>parseEdgeTrialManifest({...manifest,roomId:'71ae8719-2ceb-4308-a019-bbc9ff4b6f5d',
    roomExpiresAt:'2026-10-14T11:22:51Z'},{now}),/EDGE_TRIAL_MANIFEST_INVALID/);
  assert.throws(()=>parseEdgeTrialManifest({...manifest,projectURL:'https://example.supabase.co'},{now}),/EDGE_TRIAL_PROJECT_REQUIRED/);
  assert.throws(()=>parseEdgeTrialManifest({...manifest,trialExpiresAt:new Date(expiry+1000).toISOString().replace('.000Z','Z')},{now}),/EDGE_TRIAL_WINDOW_REQUIRED/);
  assert.throws(()=>parseEdgeTrialManifest({...manifest,mode:'prepare'},{now}),/EDGE_TRIAL_MANIFEST_INVALID/);
  const approved={...manifest,mode:'prepare',prepareApproval:{approved:true,roomId:manifest.roomId,
    expiresAt:manifest.trialExpiresAt,purpose:'edge-runtime-registration'}};
  assert.equal(parseEdgeTrialManifest(approved,{now}).enabled,true);
  assert.throws(()=>parseEdgeTrialManifest({...approved,prepareApproval:{...approved.prepareApproval,approved:false}},{now}),
    /EDGE_TRIAL_PREPARATION_APPROVAL_REQUIRED/);
  await chmod(file,0o644);
  await assert.rejects(readEdgeTrialManifest(file,{now}),/EDGE_TRIAL_MANIFEST_INVALID/);
});

test('activation file starts pending and accepts only same public registration after later approval', async t => {
  const dir = await mkdtemp(path.join('/tmp', 'vdj-edge-approval-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const activationFile = path.join(dir,'activation.json');
  const signer = await createRuntimeRequestSigner({enabled:true,scope:{roomId:EDGE_TRIAL_ROOM_ID,
    ['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,expiresAtMs:expiry},
    now,expiresAtMs:expiry});t.after(()=>signer.close());
  const files = createEdgeTrialApprovalFiles({activationFile,roomId:EDGE_TRIAL_ROOM_ID,expiresAtMs:expiry,now});
  await files.writeRegistration(signer.registration());
  assert.equal((await stat(activationFile)).mode & 0o777,0o600);
  await assert.rejects(files.readActivation(),/EDGE_TRIAL_ACTIVATION_REQUIRED/);
  const pending = JSON.parse(await readFile(activationFile,'utf8'));
  assert.deepEqual(Object.keys(pending).sort(),['approved','registration','scopedKeychainUse','version']);
  assert.equal(JSON.stringify(pending).includes('privateKey'),false);
  await writeFile(activationFile,JSON.stringify({...pending,approved:true}),{mode:0o600});
  assert.equal((await files.readActivation()).approved,true);
  await writeFile(activationFile,JSON.stringify({...pending,approved:true,scopedKeychainUse:true}),{mode:0o600});
  const keychainApproval=(await files.readActivation()).keychainApproval;
  assert.equal(keychainApproval.service,'fal.ai API (AI VDJ)');
  assert.equal(keychainApproval.account,'hapx2yuki');
  assert.equal(keychainApproval.expiresAtMs,pending.registration.expiresAtMs);
  await chmod(activationFile,0o644);
  await assert.rejects(files.readActivation(),/EDGE_TRIAL_ACTIVATION_REQUIRED/);
  await chmod(activationFile,0o600);
  await writeFile(activationFile,JSON.stringify({...pending,approved:true,
    registration:{...pending.registration,workerId:'runtime-'+crypto.randomUUID()}}),{mode:0o600});
  await assert.rejects(files.readActivation(),/EDGE_TRIAL_ACTIVATION_REQUIRED/);
});
