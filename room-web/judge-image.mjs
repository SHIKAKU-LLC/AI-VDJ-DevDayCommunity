// An optional local preview; original names and metadata never leave the tab.
const extensions = {jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp',
  heic:'image/heic', heif:'image/heic'};
export const REFERENCE_IMAGE_EXTENSIONS = '.jpg・.jpeg・.png・.webp・.heic・.heif';
export const REFERENCE_IMAGE_ACCEPT = [...new Set(Object.values(extensions)), 'image/heif',
  ...Object.keys(extensions).map(extension => '.' + extension)].join(',');

async function imageType(file) {
  // Mobile photo/file pickers can omit or mislabel File.type. Check the bytes
  // before decoding; a filename/MIME alone must not admit SVG or other content.
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 16 && text(4, 8) === 'ftyp') {
    const size = new DataView(bytes.buffer).getUint32(0);
    if (size >= 16 && size <= file.size) {
      for (let offset = 8; offset + 4 <= Math.min(size, bytes.length); offset += 4) {
        if (offset === 12) continue; // minor version, not a compatible brand
        if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(text(offset, offset + 4))) return 'image/heic';
      }
    }
  }
  throw Error('IMAGE_FORMAT_INVALID');
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close()};
    } catch {
      // Safari can render a photo through <img> even when ImageBitmap rejects it.
    }
  }
  const source = new Image();
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      source.onload = resolve;
      source.onerror = () => reject(Error('IMAGE_DECODE_FAILED'));
      source.src = url;
    });
    return {source, width: source.naturalWidth, height: source.naturalHeight,
      close: () => URL.revokeObjectURL(url)};
  } catch {
    URL.revokeObjectURL(url);
    throw Error('IMAGE_DECODE_FAILED');
  } finally {
    source.onload = null;
    source.onerror = null;
  }
}

export async function prepareReferenceImage(file) {
  if (!file || !file.size) throw Error('IMAGE_FORMAT_INVALID');
  const extension = /\.([^.]+)$/.exec(file.name ?? '')?.[1].toLowerCase();
  if (!Object.hasOwn(extensions, extension)) throw Error('IMAGE_FORMAT_INVALID');
  if (file.size > 8 * 1024 * 1024) throw Error('IMAGE_TOO_LARGE');
  const type = await imageType(file);
  if (extensions[extension] !== type) throw Error('IMAGE_FORMAT_INVALID');
  const image = await decodeImage(file.slice(0, file.size, type));
  let canvas;
  try {
    const {width, height} = image;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 32 || height < 32) throw Error('IMAGE_FORMAT_INVALID');
    // Allow 24/48 MP phone photos, then resize before allocating the canvas.
    if (width * height > 50000000) throw Error('IMAGE_TOO_LARGE');
    const ratio = Math.min(1, 1024 / width, 1024 / height);
    canvas = document.createElement('canvas');
    canvas.width = Math.max(32, Math.round(width * ratio)); canvas.height = Math.max(32, Math.round(height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw Error('IMAGE_DECODE_FAILED');
    context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('IMAGE_DECODE_FAILED');
    if (blob.size > 2 * 1024 * 1024) throw Error('IMAGE_TOO_LARGE');
    const bytes = await blob.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    return {blob, hash, previewUrl: URL.createObjectURL(blob)};
  } finally {
    image.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
