import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { ImageStoragePort, SaveImageInput } from './image-storage.port.js';

const maximumImageBytes = 8 * 1024 * 1024;
const defaultPublicBaseUrl = 'http://localhost:3000/api/uploads/item-images/files';

interface ImageFormat {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}

function detectImageFormat(bytes: Buffer): ImageFormat | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('IMAGE_PUBLIC_BASE_URL must be a valid HTTP URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('IMAGE_PUBLIC_BASE_URL must be a valid HTTP URL');
  }
  return parsed.toString().replace(/\/$/, '');
}

@Injectable()
export class LocalImageStorageAdapter implements ImageStoragePort {
  readonly directory: string;
  private readonly publicBaseUrl: string;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Local image storage cannot be selected in production');
    }
    this.directory = resolve(
      process.env.LOCAL_IMAGE_STORAGE_DIR ?? '.local/item-images',
    );
    this.publicBaseUrl = validateBaseUrl(
      process.env.IMAGE_PUBLIC_BASE_URL ?? defaultPublicBaseUrl,
    );
  }

  async save({ contentType, bytes }: SaveImageInput): Promise<{ url: string }> {
    if (bytes.length === 0 || bytes.length > maximumImageBytes) {
      throw new BadRequestException(
        'Image size must be between 1 byte and 8 MB',
      );
    }
    const format = detectImageFormat(bytes);
    if (!format || format.contentType !== contentType) {
      throw new BadRequestException(
        'Only valid JPEG, PNG, or WebP images are accepted',
      );
    }
    const filename = `${randomUUID()}.${format.extension}`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(resolve(this.directory, filename), bytes, { flag: 'wx' });
    return { url: `${this.publicBaseUrl}/${filename}` };
  }

  async read(filename: string): Promise<{ bytes: Buffer; contentType: string }> {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp)$/.exec(
        filename,
      );
    if (!match) throw new NotFoundException('Image was not found');
    try {
      const bytes = await readFile(resolve(this.directory, filename));
      const contentTypes = {
        jpg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
      } as const;
      return {
        bytes,
        contentType: contentTypes[match[2] as keyof typeof contentTypes],
      };
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new NotFoundException('Image was not found');
      }
      throw error;
    }
  }
}
