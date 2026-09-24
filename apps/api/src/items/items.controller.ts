import { CreateItemSchema, UpdateItemSchema } from '@barter/contracts';
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
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ItemsService } from './items.service.js';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CUSTOMER')
export class ItemsController {
  constructor(@Inject(ItemsService) private readonly itemsService: ItemsService) {}

  @Post('items')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateItemSchema)) body: unknown,
  ) {
    return this.itemsService.create(user.id, CreateItemSchema.parse(body));
  }

  @Patch('items/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodValidationPipe(UpdateItemSchema)) body: unknown,
  ) {
    return this.itemsService.update(user.id, itemId, UpdateItemSchema.parse(body));
  }

  @Post('items/:id/submit')
  @HttpCode(200)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    return this.itemsService.submit(user.id, itemId, key, requestId);
  }

  @Get('me/items')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.itemsService.listOwned(user.id);
  }

  @Get('me/items/:id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) itemId: string,
  ) {
    return this.itemsService.getOwned(user.id, itemId);
  }
}
