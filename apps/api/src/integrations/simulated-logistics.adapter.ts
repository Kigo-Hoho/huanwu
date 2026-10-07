import { Inject, Injectable } from '@nestjs/common';
import type { LogisticsPort } from '../logistics/logistics.port.js';
import type { ProviderOperation, ProviderResult, VerifiedIntegrationEvent } from './integration.types.js';
import { SimulatedProviderStore } from './simulated-provider.store.js';
import { BadRequestException } from '@nestjs/common';

@Injectable()
export class SimulatedLogisticsAdapter implements LogisticsPort {
  constructor(@Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore) {}
  async verifyShipment(operation: ProviderOperation): Promise<ProviderResult> {
    this.store.assertEnabled('logistics');
    if (operation.kind !== 'VERIFY_SHIPMENT') throw new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Wrong operation kind for logistics capability' });
    return this.store.execute(operation);
  }
  async queryShipment(businessNo: string): Promise<ProviderResult> { this.store.assertEnabled('logistics'); return this.store.query(businessNo, ['VERIFY_SHIPMENT', 'QUERY_SHIPMENT']); }
  verifySignedEvent(raw: string, signature: string): VerifiedIntegrationEvent { return this.store.verifySignedEvent(raw, signature, 'logistics'); }
}
