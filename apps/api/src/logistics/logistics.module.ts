import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ClockModule } from '../common/clock.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { OrderHandoverService } from '../orders/order-handover.service.js';
import { ShipmentsService } from './shipments.service.js';
import { LogisticsEventsService } from './logistics-events.service.js';
import { OrderFulfillmentController } from './order-fulfillment.controller.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { LogisticsOutboxHandler } from './logistics-outbox.handler.js';
@Module({ imports: [AuthModule, AuditModule, ClockModule, IntegrationsModule, OrdersModule, ReservationsModule], controllers: [OrderFulfillmentController], providers: [ShipmentsService, LogisticsEventsService, OrderHandoverService, LogisticsOutboxHandler], exports: [ShipmentsService, LogisticsEventsService, OrderHandoverService, LogisticsOutboxHandler] })
export class LogisticsModule {}
