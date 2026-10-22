import { createDecipheriv, createHash } from 'node:crypto';
import { invariant } from './errors.mjs';
import { rasterType } from './raster-image.mjs';

const limit = 50 * 1024 * 1024;
export function weixinAttachment(item) {
  if (item.type === 4) return { ...item.file_item, kind: 'file' };
  invariant(item.type === 2 && item.image_item, 400, 'WEIXIN_IMAGE_INVALID', '微信图片消息不完整。');
  const image = item.image_item, media = { ...image.media };
  invariant(media.full_url || media.encrypt_query_param, 400, 'WEIXIN_IMAGE_INVALID', '微信图片缺少下载地址。');
  if (image.aeskey) {
    invariant(/^[a-f0-9]{32}$/i.test(image.aeskey), 400, 'WEIXIN_IMAGE_INVALID', '微信图片密钥格式无效。');
    media.aes_key = Buffer.from(image.aeskey, 'hex').toString('base64');
  }
  invariant(Math.max(Number(image.hd_size) || 0, Number(image.mid_size) || 0) <= limit,
    413, 'MATERIAL_LIMIT', '资料超过 50 MiB。');
  return { kind: 'image', media };
}

export function decodeWeixinAttachment(item, downloaded) {
  invariant(downloaded.length <= limit + 32, 413, 'MATERIAL_LIMIT', '资料超过 50 MiB。');
  let bytes = downloaded;
  if (item.media?.aes_key) {
    let key = Buffer.from(item.media.aes_key, 'base64');
    if (key.length === 32 && /^[a-f0-9]{32}$/i.test(key.toString())) key = Buffer.from(key.toString(), 'hex');
    invariant(key.length === 16, 400, 'WEIXIN_FILE_INVALID', '微信附件密钥无效。');
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    bytes = Buffer.concat([decipher.update(downloaded), decipher.final()]);
  } else invariant(item.kind === 'image', 400, 'WEIXIN_FILE_INVALID', '微信文件缺少密钥。');
  invariant(bytes.length <= limit && (!item.len || Number(item.len) === bytes.length)
    && (!item.md5 || createHash('md5').update(bytes).digest('hex') === item.md5.toLowerCase()),
  400, 'WEIXIN_FILE_INVALID', '微信附件大小或校验值不一致。');
  if (item.kind === 'image') invariant(rasterType(bytes), 415, 'WEIXIN_IMAGE_INVALID', '微信图片不是支持的位图格式。');
  return bytes;
}

export function weixinAttachmentName(item, bytes, index) {
  if (item.kind !== 'image') return item.file_name;
  const type = rasterType(bytes);
  invariant(type, 415, 'WEIXIN_IMAGE_INVALID', '微信图片不是支持的位图格式。');
  return `微信图片-${index + 1}.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}`;
}
