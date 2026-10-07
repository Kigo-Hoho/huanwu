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
import { OrderHoldService } from './order-hold.service.js';
import { OrderCancellationEngine } from './order-cancellation-engine.service.js';
import { OrderExpiryService } from './order-expiry.service.js';
import { OrderExpiryScheduler } from './order-expiry.scheduler.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { AdminOrdersService } from './admin-orders.service.js';
@Module({ imports: [AuthModule, AuditModule, ClockModule, ProposalsModule, ReservationsModule, IntegrationsModule], controllers: [OrdersController, AdminOrdersController], providers: [OrdersService, AdminOrdersService, OrderCommandsService, AddressCipher, OrderAddressService, OrderCancellationService, OrderCancellationEngine, OrderHoldService, OrderExpiryService, OrderExpiryScheduler], exports: [OrdersService, OrderCommandsService, OrderAddressService, OrderCancellationService, OrderHoldService, OrderExpiryService] })
export class OrdersModule {}
