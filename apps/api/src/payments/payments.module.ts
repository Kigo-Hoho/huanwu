import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PaymentOutboxHandler } from './payment-outbox.handler.js';
import { SettlementService } from './settlement.service.js';
import { OrderAcceptanceController } from '../orders/order-acceptance.controller.js';
import { OrderAcceptanceService } from '../orders/order-acceptance.service.js';

@Module({ imports: [OrdersModule, IntegrationsModule, AuthModule, AuditModule, ClockModule, ReservationsModule], controllers: [PaymentsController, OrderAcceptanceController], providers: [PaymentsService, PaymentEventsService, PaymentOutboxHandler, SettlementService, OrderAcceptanceService], exports: [PaymentsService, PaymentEventsService, SettlementService] })
export class PaymentsModule {}
