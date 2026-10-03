import { Module } from '@nestjs/common';
import { ClockModule } from '../common/clock.module.js';
import { PAYMENT_PORT } from '../payments/payment.port.js';
import { LOGISTICS_PORT } from '../logistics/logistics.port.js';
import { INTEGRATION_CONFIG, integrationConfiguration } from './integration-config.js';
import { OutboxService } from './outbox.service.js';
import { OutboxWorker } from './outbox.worker.js';
import { OutboxHandlerRegistry } from './outbox-handler.registry.js';
import { SimulatedProviderStore } from './simulated-provider.store.js';
import { SimulatedPaymentAdapter } from './simulated-payment.adapter.js';
import { SimulatedLogisticsAdapter } from './simulated-logistics.adapter.js';

@Module({
  imports: [ClockModule],
  providers: [
    { provide: INTEGRATION_CONFIG, useFactory: integrationConfiguration },
    OutboxService, OutboxWorker, OutboxHandlerRegistry, SimulatedProviderStore, SimulatedPaymentAdapter, SimulatedLogisticsAdapter,
    { provide: PAYMENT_PORT, useExisting: SimulatedPaymentAdapter },
    { provide: LOGISTICS_PORT, useExisting: SimulatedLogisticsAdapter },
  ],
  exports: [OutboxService, OutboxWorker, OutboxHandlerRegistry, SimulatedProviderStore, SimulatedPaymentAdapter, SimulatedLogisticsAdapter, PAYMENT_PORT, LOGISTICS_PORT],
})
export class IntegrationsModule {}
