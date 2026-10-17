import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digestRuntimeBytes} from '../../cloud/room/runtime-request-proof.mjs';
import {APPROVED_KEYCHAIN_ITEM} from './keychain-provider.mjs';

export const EDGE_TRIAL_ROOM_ID = 'cbbd796a-dc42-4b51-99fd-a9a575980740';
export const EDGE_TRIAL_ROOM_EXPIRES_AT = '2026-10-14T16:00:58Z';
export const EDGE_TRIAL_PROJECT_URL = 'https://sbrghwehlkptbnbxhymu.supabase.co';
const ROOM_EXPIRES_AT_MS = Date.parse(EDGE_TRIAL_ROOM_EXPIRES_AT);
const CLOUD_ORIGIN = 'https://ai-vdj.vercel.app';
const MANIFEST_VERSION = 'ai-vdj-edge-trial-v1';
const ACTIVATION_VERSION = 'ai-vdj-edge-activation-v1';
const MAX_FILE_BYTES = 8192;
const encoder = new TextEncoder();
const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const fail = code => { throw Error(code); };
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  try { return new Date(value).toISOString().replace('.000Z', 'Z') === value; } catch { return false; }
};
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
const stable = value => Array.isArray(value) ? value.map(stable) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

function privateJsonPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      path.extname(value) !== '.json' || value.includes('\0')) fail('EDGE_TRIAL_PATH_REQUIRED');
  // Approval files contain no secrets, but must remain outside the tracked tree.
  const relative = path.relative(fileURLToPath(new URL('../..', import.meta.url)), value);
  if (relative === '' || relative === '.' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
    fail('EDGE_TRIAL_PATH_REQUIRED');
  return value;
}

async function readPrivateJson(file, code) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size < 2 || (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail(code);
    return JSON.parse(await handle.readFile({encoding: 'utf8'}));
  } catch { fail(code); }
  finally { await handle?.close(); }
}

export function parseEdgeTrialManifest(value, {now = Date.now, manifestPath} = {}) {
  const base = ['version', 'roomId', 'projectURL', 'cloudOrigin', 'roomExpiresAt', 'trialExpiresAt', 'mode',
    'activationFile'];
  const keys = [...base,...(value?.operationalApprovalFile === undefined ? [] : ['operationalApprovalFile']),
    ...(value?.mode === 'prepare' ? ['prepareApproval'] : [])];
  if (!exact(value, keys) ||
      value.version !== MANIFEST_VERSION || value.roomId !== EDGE_TRIAL_ROOM_ID ||
      value.cloudOrigin !== CLOUD_ORIGIN || value.roomExpiresAt !== EDGE_TRIAL_ROOM_EXPIRES_AT ||
      !iso(value.trialExpiresAt) || !['dormant', 'prepare'].includes(value.mode)) fail('EDGE_TRIAL_MANIFEST_INVALID');
  const current = now(), expiresAtMs = Date.parse(value.trialExpiresAt);
  if (!Number.isSafeInteger(current) || expiresAtMs < current + 1000 || expiresAtMs > current + 30 * 60_000 ||
      expiresAtMs > ROOM_EXPIRES_AT_MS) fail('EDGE_TRIAL_WINDOW_REQUIRED');
  if (value.projectURL !== EDGE_TRIAL_PROJECT_URL) fail('EDGE_TRIAL_PROJECT_REQUIRED');
  const activationFile = privateJsonPath(value.activationFile);
  const operationalApprovalFile = value.operationalApprovalFile === undefined ? null :
    privateJsonPath(value.operationalApprovalFile);
  if (activationFile === operationalApprovalFile || manifestPath &&
      [activationFile,operationalApprovalFile].includes(path.resolve(manifestPath))) fail('EDGE_TRIAL_PATH_REQUIRED');
  if (value.mode === 'prepare' && (!exact(value.prepareApproval, ['approved', 'roomId', 'expiresAt', 'purpose']) ||
      value.prepareApproval.approved !== true || value.prepareApproval.roomId !== value.roomId ||
      value.prepareApproval.expiresAt !== value.trialExpiresAt ||
      value.prepareApproval.purpose !== 'edge-runtime-registration')) fail('EDGE_TRIAL_PREPARATION_APPROVAL_REQUIRED');
  return Object.freeze({roomId: value.roomId, projectURL: value.projectURL, cloudOrigin: value.cloudOrigin,
    roomExpiresAtMs: ROOM_EXPIRES_AT_MS, expiresAtMs, mode: value.mode, activationFile, operationalApprovalFile,
    enabled: value.mode === 'prepare'});
}

export async function readEdgeTrialManifest(file, options = {}) {
  const manifestPath = privateJsonPath(file);
  return parseEdgeTrialManifest(await readPrivateJson(manifestPath, 'EDGE_TRIAL_MANIFEST_INVALID'),
    {...options, manifestPath});
}

async function validateRegistration(value, {roomId, expiresAtMs, now}) {
  if (!exact(value, ['workerId', 'roomId', 'sessionId', 'controlRevision', 'approvedAtMs',
    'expiresAtMs', 'publicJwk', 'publicKeySha256']) ||
    !/^runtime-[a-f0-9-]{36}$/.test(value.workerId) || value.roomId !== roomId ||
    !/^[a-f0-9-]{36}$/.test(value.sessionId) || !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0 ||
    !Number.isSafeInteger(value.approvedAtMs) || value.approvedAtMs > now() ||
    !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= now() || value.expiresAtMs > expiresAtMs ||
    value.expiresAtMs > value.approvedAtMs + 30 * 60_000 ||
    !exact(value.publicJwk, ['key_ops', 'ext', 'alg', 'kty', 'x', 'crv']) ||
    value.publicJwk.kty !== 'OKP' || value.publicJwk.crv !== 'Ed25519' ||
    value.publicJwk.alg !== 'Ed25519' ||
    value.publicJwk.ext !== true || !Array.isArray(value.publicJwk.key_ops) ||
    value.publicJwk.key_ops.length !== 1 || value.publicJwk.key_ops[0] !== 'verify' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.publicJwk.x) ||
    !/^[a-f0-9]{64}$/.test(value.publicKeySha256) ||
    value.publicKeySha256 !== await digestRuntimeBytes(encoder.encode(canonical(value.publicJwk))))
    fail('EDGE_TRIAL_REGISTRATION_INVALID');
  return structuredClone(value);
}

// The pending file is public registration metadata only. The operator reviews
// it separately, sets approved=true, and the native callback re-reads it later.
export function createEdgeTrialApprovalFiles({activationFile, roomId, expiresAtMs, now = Date.now} = {}) {
  const file = privateJsonPath(activationFile);
  if (roomId !== EDGE_TRIAL_ROOM_ID || !Number.isSafeInteger(expiresAtMs) || expiresAtMs > ROOM_EXPIRES_AT_MS)
    fail('EDGE_TRIAL_SCOPE_REQUIRED');
  let expected;
  return Object.freeze({
    async writeRegistration(registration) {
      if (expected) fail('EDGE_TRIAL_REGISTRATION_EXISTS');
      const checked = await validateRegistration(registration, {roomId, expiresAtMs, now});
      const record = {version: ACTIVATION_VERSION, registration: checked, approved: false, scopedKeychainUse: false};
      let handle;
      try {
        handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(JSON.stringify(record) + '\n', {encoding: 'utf8'});
        await handle.sync();
        expected = checked;
      } catch { fail('EDGE_TRIAL_REGISTRATION_WRITE_FAILED'); }
      finally { await handle?.close(); }
      return checked;
    },
    async readActivation(registration) {
      if (!expected || now() >= expiresAtMs) fail('EDGE_TRIAL_ACTIVATION_REQUIRED');
      if (registration && JSON.stringify(stable(registration)) !== JSON.stringify(stable(expected)))
        fail('EDGE_TRIAL_ACTIVATION_REQUIRED');
      const record = await readPrivateJson(file, 'EDGE_TRIAL_ACTIVATION_REQUIRED');
      if (!exact(record, ['version', 'registration', 'approved', 'scopedKeychainUse']) ||
          record.version !== ACTIVATION_VERSION || record.approved !== true ||
          typeof record.scopedKeychainUse !== 'boolean') fail('EDGE_TRIAL_ACTIVATION_REQUIRED');
      const checked = await validateRegistration(record.registration, {roomId, expiresAtMs, now});
      if (JSON.stringify(stable(checked)) !== JSON.stringify(stable(expected))) fail('EDGE_TRIAL_ACTIVATION_REQUIRED');
      return Object.freeze({approved: true, registration: checked,
        ...(record.scopedKeychainUse ? {keychainApproval: {...checked, ...APPROVED_KEYCHAIN_ITEM,
          approved: true, process: 'ai-vdj-native-node', recipient: 'fal-fixed-generation-and-platform'}} : {})});
    },
  });
}
