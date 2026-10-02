import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { OrderCommandsService } from './order-commands.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
@Module({ imports: [AuthModule, AuditModule, ClockModule, ProposalsModule, ReservationsModule], controllers: [OrdersController], providers: [OrdersService, OrderCommandsService], exports: [OrdersService, OrderCommandsService] })
export class OrdersModule {}
