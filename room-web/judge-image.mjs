// An optional local preview; original names and metadata never leave the tab.
export async function prepareReferenceImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('IMAGE_FORMAT_INVALID');
  if (file.size > 8 * 1024 * 1024) throw Error('IMAGE_TOO_LARGE');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 32 || bitmap.height < 32 || bitmap.width * bitmap.height > 20000000) throw Error('IMAGE_FORMAT_INVALID');
    const ratio = Math.min(1, 1024 / bitmap.width, 1024 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(32, Math.round(bitmap.width * ratio)); canvas.height = Math.max(32, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 2 * 1024 * 1024) throw Error('IMAGE_TOO_LARGE');
    const bytes = await blob.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    return {blob, hash, previewUrl: URL.createObjectURL(blob)};
  } finally { bitmap.close(); }
}
