import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { EvidenceImageMetadataSchema, type EvidenceImageMetadata } from '@barter/contracts';
import type { EvidenceUpload } from './evidence-storage.port.js';

export interface ValidatedEvidence { metadata: EvidenceImageMetadata; preview: Buffer; previewContentType: 'image/webp' }
@Injectable()
export class EvidenceImageValidator {
  async validate(input: EvidenceUpload): Promise<ValidatedEvidence> {
    const invalid = () => new BadRequestException('Only decodable JPEG, PNG or WebP images within the evidence limits are accepted');
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0 || input.bytes.length > 8388608) throw invalid();
    try {
      const options = { failOn: 'warning' as const, limitInputPixels: 40000000 };
      const decoder = sharp(input.bytes, options);
      const header = await decoder.metadata();
      if (header.format !== 'jpeg' && header.format !== 'png' && header.format !== 'webp') throw invalid();
      const mimeType = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[header.format];
      const metadata = EvidenceImageMetadataSchema.parse({ mimeType, bytes: input.bytes.length, width: header.width, height: header.height, sha256: createHash('sha256').update(input.bytes).digest('hex') });
      if (mimeType !== input.contentType) throw invalid();
      // metadata() only reads headers. Decode every pixel (including later
      // animated frames), so truncated or corrupt image data is rejected.
      await sharp(input.bytes, { ...options, animated: true }).raw().toBuffer();
      const preview = await decoder.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
      return { metadata, preview, previewContentType: 'image/webp' };
    } catch { throw invalid(); }
  }
}
