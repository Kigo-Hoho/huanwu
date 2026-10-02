import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminItemsController } from './admin-items.controller.js';
import { ItemReviewService } from './item-review.service.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ItemsController, AdminItemsController],
  providers: [ItemsService, ItemReviewService],
  exports: [ItemsService],
})
export class ItemsModule {}
