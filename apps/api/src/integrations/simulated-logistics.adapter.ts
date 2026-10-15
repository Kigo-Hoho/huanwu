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
  async verifyReturn(operation: ProviderOperation): Promise<ProviderResult> {
    this.store.assertEnabled('logistics');
    if (operation.kind !== 'VERIFY_RETURN') throw new BadRequestException('Wrong return operation');
    return this.store.execute(operation);
  }
  async queryReturn(operation: ProviderOperation): Promise<ProviderResult> { this.store.assertEnabled('logistics'); return this.store.query(operation.businessNo, ['VERIFY_RETURN']); }
  async closeOrIntercept(operation: ProviderOperation): Promise<ProviderResult> {
    this.store.assertEnabled('logistics');
    if (operation.kind !== 'CLOSE_OR_INTERCEPT') throw new BadRequestException('Wrong interception operation');
    return this.store.execute(operation);
  }
  async queryInterception(operation: ProviderOperation): Promise<ProviderResult> { this.store.assertEnabled('logistics'); return this.store.query(operation.businessNo, ['CLOSE_OR_INTERCEPT']); }
  verifySignedEvent(raw: string, signature: string): VerifiedIntegrationEvent { return this.store.verifySignedEvent(raw, signature, 'logistics'); }
}
