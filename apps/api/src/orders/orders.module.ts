import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { OrderCommandsService } from './order-commands.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { AddressCipher } from './address-cipher.js';
import { OrderAddressService } from './order-address.service.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { OrderCancellationService } from './order-cancellation.service.js';
@Module({ imports: [AuthModule, AuditModule, ClockModule, ProposalsModule, ReservationsModule, IntegrationsModule], controllers: [OrdersController], providers: [OrdersService, OrderCommandsService, AddressCipher, OrderAddressService, OrderCancellationService], exports: [OrdersService, OrderCommandsService, OrderAddressService, OrderCancellationService] })
export class OrdersModule {}
