import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IMAGE_STORAGE_PORT } from './image-storage.port.js';
import { ItemImagesController } from './item-images.controller.js';
import { LocalImageStorageAdapter } from './local-image-storage.adapter.js';

@Module({
  imports: [AuthModule],
  controllers: [ItemImagesController],
  providers: [
    LocalImageStorageAdapter,
    { provide: IMAGE_STORAGE_PORT, useExisting: LocalImageStorageAdapter },
  ],
  exports: [IMAGE_STORAGE_PORT],
})
export class StorageModule {}
