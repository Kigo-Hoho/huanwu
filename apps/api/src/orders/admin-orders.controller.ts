import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOrdersService } from './admin-orders.service.js';
import { orderListQuerySchema } from './order-list-query.js';

@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
export class AdminOrdersController {
  constructor(@Inject(AdminOrdersService) private readonly orders: AdminOrdersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(orderListQuerySchema)) query: z.output<typeof orderListQuerySchema>) { return this.orders.list(query); }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) { return this.orders.detail(id.toLowerCase()); }
}
