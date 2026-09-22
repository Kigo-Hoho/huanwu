import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import {
  IMAGE_STORAGE_PORT,
  type ImageStoragePort,
} from './image-storage.port.js';
import {
  isLocalImageStorageEnvironment,
  LocalImageStorageAdapter,
} from './local-image-storage.adapter.js';

interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
}

@Controller('uploads/item-images')
export class ItemImagesController {
  constructor(
    @Inject(IMAGE_STORAGE_PORT)
    private readonly storage: ImageStoragePort,
    private readonly localStorage: LocalImageStorageAdapter,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('An image file is required');
    return await this.storage.save({
      ownerId: user.id,
      contentType: file.mimetype,
      bytes: file.buffer,
    });
  }

  @Get('files/:filename')
  async serve(
    @Param('filename') filename: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!isLocalImageStorageEnvironment()) {
      throw new NotFoundException('Image was not found');
    }
    const stored = await this.localStorage.read(filename);
    response.setHeader('Content-Type', stored.contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(stored.bytes);
  }
}
