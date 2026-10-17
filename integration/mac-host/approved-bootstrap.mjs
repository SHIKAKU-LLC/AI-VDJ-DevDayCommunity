import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectReferenceImage} from './native.mjs';
import {prepareBootstrap} from '../runtime/bootstrap.mjs';

// Only an operator-supplied local manifest of previously approved exact files.
// Paths stay native. Neither the manifest nor bytes are exposed over HTTP.
export async function readApprovedBootstrap(manifestPath, {inspectImage = inspectReferenceImage, prepare = prepareBootstrap} = {}) {
  const raw = await readFile(manifestPath);
  if (raw.length > 4096) throw Error('BOOTSTRAP_MANIFEST_INVALID');
  const manifest = JSON.parse(raw);
  if (Object.keys(manifest).sort().join(',') !== 'audio,reference') throw Error('BOOTSTRAP_MANIFEST_INVALID');
  const result = {};
  for (const [key, maximum] of [['audio', 32 * 1024 * 1024], ['reference', 4 * 1024 * 1024]]) {
    const item = manifest[key];
    if (!item || Object.keys(item).sort().join(',') !== 'path,sha256' || typeof item.path !== 'string' ||
        !item.path.startsWith('/') || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('BOOTSTRAP_MANIFEST_INVALID');
    const bytes = await readFile(item.path);
    if (bytes.length > maximum || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw Error('APPROVED_BOOTSTRAP_CHANGED');
    result[key] = bytes;
  }
  if (await inspectImage(result.reference) !== true) throw Error('IMAGE_DECODE_REQUIRED');
  return prepare({audioBytes: result.audio, referenceBytes: result.reference});
}
