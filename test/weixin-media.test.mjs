import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { weixinAttachment, decodeWeixinAttachment, weixinAttachmentName } from '../src/weixin-media.mjs';
import { imageToolResult, toolImageContent, IMAGE_MAX_BYTES } from '../src/raster-image.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=', 'base64');
const key = Buffer.alloc(16, 7), media = { full_url: 'https://novac2c.cdn.weixin.qq.com/fixture' };

test('Weixin images support pinned hex/base64 AES formats and plain CDN without trusting image size hints', () => {
  const cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  for (const image of [
    { aeskey: key.toString('hex'), media, mid_size: encrypted.length },
    { media: { ...media, aes_key: key.toString('base64') } },
    { media: { ...media, aes_key: Buffer.from(key.toString('hex')).toString('base64') } },
  ]) {
    const item = weixinAttachment({ type: 2, image_item: image });
    assert.deepEqual(decodeWeixinAttachment(item, encrypted), png);
    assert.equal(weixinAttachmentName(item, png, 0), '微信图片-1.png');
  }
  assert.deepEqual(decodeWeixinAttachment(weixinAttachment({ type: 2, image_item: { media } }), png), png);
  assert.throws(() => weixinAttachment({ type: 2, image_item: { media, aeskey: 'invalid' } }));
  assert.throws(() => decodeWeixinAttachment({ kind: 'image', media }, Buffer.from('<svg>unsafe</svg>')));
  assert.throws(() => weixinAttachment({ type: 2, image_item: { media, hd_size: 51 * 1024 ** 2 } }));
  const file = { kind: 'file', media: { ...media, aes_key: key.toString('base64') }, len: String(png.length), md5: createHash('md5').update(png).digest('hex') };
  assert.deepEqual(decodeWeixinAttachment(file, encrypted), png);
  assert.throws(() => decodeWeixinAttachment({ ...file, len: '1' }, encrypted));
  assert.throws(() => decodeWeixinAttachment({ ...file, md5: 'wrong' }, encrypted));
});

test('image pixels are native-only and cannot be serialized into tool details or replay', () => {
  const result = imageToolResult(png, { name: 'image.png' });
  assert.equal(toolImageContent(result).type, 'inputImage');
  assert.equal(JSON.stringify(result).includes(png.toString('base64')), false);
  assert.equal(toolImageContent({ imageUrl: 'forged' }), null);
  assert.throws(() => imageToolResult(Buffer.from('<svg/>')));
  assert.throws(() => imageToolResult(Buffer.concat([png, Buffer.alloc(IMAGE_MAX_BYTES)])), { code: 'IMAGE_TOO_LARGE' });
});
