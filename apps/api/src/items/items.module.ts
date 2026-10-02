import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminItemsController } from './admin-items.controller.js';
import { ItemReviewService } from './item-review.service.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { PublicItemsController } from './public-items.controller.js';
import { PublicItemsService } from './public-items.service.js';
import { ClockModule } from '../common/clock.module.js';

@Module({
  imports: [AuthModule, AuditModule, ClockModule],
  controllers: [ItemsController, AdminItemsController, PublicItemsController],
  providers: [ItemsService, ItemReviewService, PublicItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
