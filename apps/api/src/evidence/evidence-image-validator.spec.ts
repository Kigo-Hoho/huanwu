import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { EvidenceImageValidator } from './evidence-image-validator.js';

const validator = new EvidenceImageValidator();
it.each(['jpeg', 'png', 'webp'] as const)('decodes real %s bytes, preserves their digest and produces a metadata-free preview', async format => {
  const bytes = await sharp({ create: { width: 24, height: 12, channels: 3, background: 'red' } }).toFormat(format).withExif({ IFD0: { Copyright: 'private-camera-location' } }).toBuffer();
  expect((await sharp(bytes).metadata()).exif).toBeDefined();
  const result = await validator.validate({ bytes, contentType: `image/${format}` });
  expect(result.metadata).toEqual({ width: 24, height: 12, bytes: bytes.length, mimeType: `image/${format}`, sha256: createHash('sha256').update(bytes).digest('hex') });
  const preview = await sharp(result.preview).metadata();
  expect(preview).toMatchObject({ format: 'webp', width: 24, height: 12 });
  expect(preview.exif).toBeUndefined();
  expect(preview.icc).toBeUndefined();
  expect(preview.xmp).toBeUndefined();
});
it('rejects spoofed MIME, SVG, empty, truncated and oversized actual input', async () => {
  const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  for (const input of [
    { bytes: jpeg, contentType: 'image/png' },
    { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), contentType: 'image/svg+xml' },
    { bytes: Buffer.alloc(0), contentType: 'image/jpeg' },
    { bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' },
    { bytes: jpeg.subarray(0, jpeg.length - 12), contentType: 'image/jpeg' },
    { bytes: Buffer.alloc(8388609), contentType: 'image/jpeg' },
  ]) await expect(validator.validate(input)).rejects.toMatchObject({ status: 400 });
});
it('bounds actual decoded image dimensions and pixel count', async () => {
  const accepted = await sharp({ create: { width: 8192, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  expect((await validator.validate({ bytes: accepted, contentType: 'image/png' })).metadata.width).toBe(8192);
  for (const [width, height] of [[8193, 1], [8000, 5001]]) {
    const bytes = await sharp({ create: { width, height, channels: 3, background: 'white' } }).png().toBuffer();
    await expect(validator.validate({ bytes, contentType: 'image/png' })).rejects.toMatchObject({ status: 400 });
  }
});
