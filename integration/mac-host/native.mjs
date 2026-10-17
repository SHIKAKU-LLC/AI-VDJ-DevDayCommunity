import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const run = promisify(execFile);
const quoted = text => JSON.stringify(String(text));

// Dialog source travels over stdin, not command arguments or a shell/log.
export function macDialog({message, confirmLabel = '続ける', cancel = true, copyText}) {
  if (process.platform !== 'darwin') return Promise.reject(Error('MAC_NATIVE_UI_REQUIRED'));
  const script = `display dialog ${quoted(message)} buttons ${cancel ? '{"キャンセル", ' : '{'}${quoted(confirmLabel)}} default button ${quoted(confirmLabel)}${cancel ? ' cancel button "キャンセル"' : ''}${copyText === undefined ? '' : ' default answer ' + quoted(copyText)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], {stdio: ['pipe', 'ignore', 'ignore']});
    child.on('error', () => reject(Error('NATIVE_CONFIRMATION_FAILED')));
    child.on('close', code => code === 0 ? resolve(true) : reject(Error('OWNER_CANCELLED')));
    child.stdin.on('error', () => {}); child.stdin.end(script);
  });
}

// Existing task permission is session BYOK only. Never read the Keychain.
// The owner explicitly supplies a credential through a temporary input UI.
export function createOwnerCredentialAccess({confirm = macDialog, requestSessionCredential}) {
  if (typeof requestSessionCredential !== 'function') throw Error('OWNER_SESSION_INPUT_REQUIRED');
  return Object.freeze({async withCredential(use) {
    if (typeof use !== 'function') throw Error('NATIVE_OPERATION_REQUIRED');
    if (await confirm({message: '本人が入力するキーを、この操作の一時セッション内だけで使用します。', confirmLabel: '一時入力へ'}) !== true)
      throw Error('OWNER_CANCELLED');
    let credential;
    try {
      credential = await requestSessionCredential();
      if (typeof credential !== 'string' || !credential.length) throw Error('OWNER_CREDENTIAL_UNAVAILABLE');
      return await use(credential);
    } finally { credential = undefined; }
  }});
}

export async function inspectReferenceImage(bytes) {
  if (process.platform !== 'darwin') throw Error('MAC_IMAGE_DECODER_REQUIRED');
  const dir = await mkdtemp(path.join(tmpdir(), 'vdj-image-check-'));
  try {
    const input = path.join(dir, 'reference'); const output = path.join(dir, 'decoded.png');
    await writeFile(input, bytes, {mode: 0o600});
    // Actual decode/reencode; stdout/stderr and file paths never reach API errors.
    await run('/usr/bin/sips', ['-s', 'format', 'png', input, '--out', output], {timeout: 15000, maxBuffer: 4096});
    return true;
  } catch { throw Error('REFERENCE_IMAGE_DECODE_FAILED'); }
  finally { await rm(dir, {recursive: true, force: true}); }
}
