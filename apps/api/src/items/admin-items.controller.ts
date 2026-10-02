import { ReviewItemSchema } from '@barter/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ItemReviewService } from './item-review.service.js';

@Controller('admin/items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('REVIEWER', 'SUPER_ADMIN')
export class AdminItemsController {
  constructor(
    @Inject(ItemReviewService)
    private readonly itemReviewService: ItemReviewService,
  ) {}

  @Get()
  list(@Query('status') status?: string) {
    if (status !== undefined && status !== 'PENDING_REVIEW') {
      throw new BadRequestException('Only PENDING_REVIEW can be listed');
    }
    return this.itemReviewService.listPending();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) itemId: string) {
    return this.itemReviewService.getDetail(itemId);
  }

  @Post(':id/reviews')
  @HttpCode(200)
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodValidationPipe(ReviewItemSchema)) body: unknown,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    return this.itemReviewService.review(
      itemId,
      user,
      ReviewItemSchema.parse(body),
      requestId,
    );
  }
}
