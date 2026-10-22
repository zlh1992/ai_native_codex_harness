import { invariant } from './errors.mjs';

const imageContent = Symbol('portal-image-content');
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function rasterType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function imageToolResult(bytes, metadata = {}) {
  const mimeType = rasterType(bytes);
  invariant(mimeType, 415, 'IMAGE_UNSUPPORTED', '仅支持 PNG、JPEG、GIF 和 WebP 位图。');
  invariant(bytes.length <= IMAGE_MAX_BYTES, 413, 'IMAGE_TOO_LARGE', '模型读取图片最多 20 MiB；原图仍可作为附件下载。');
  // Keep pixels off JSON events, tool details and summaries; only the native model receives them.
  return Object.defineProperty({ ...metadata, mimeType, size: bytes.length, imageProvided: true }, imageContent,
    { value: { type: 'inputImage', imageUrl: `data:${mimeType};base64,${bytes.toString('base64')}` } });
}

export function toolImageContent(value) { return value?.[imageContent] || null; }
