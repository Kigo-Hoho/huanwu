import { Inject, Injectable } from '@nestjs/common';
import type { PaymentPort } from '../payments/payment.port.js';
import type { ProviderOperation, ProviderResult, VerifiedIntegrationEvent } from './integration.types.js';
import { SimulatedProviderStore } from './simulated-provider.store.js';
import { BadRequestException } from '@nestjs/common';

@Injectable()
export class SimulatedPaymentAdapter implements PaymentPort {
  constructor(@Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore) {}
  createPayment(operation: ProviderOperation): Promise<ProviderResult> { return this.execute(operation, 'CREATE_PAYMENT'); }
  queryPayment(businessNo: string): Promise<ProviderResult> { return this.query(businessNo, ['CREATE_PAYMENT', 'CLOSE_PAYMENT']); }
  closePayment(operation: ProviderOperation): Promise<ProviderResult> { return this.execute(operation, 'CLOSE_PAYMENT'); }
  refundPayment(operation: ProviderOperation): Promise<ProviderResult> { return this.execute(operation, 'REFUND_PAYMENT'); }
  queryRefund(businessNo: string): Promise<ProviderResult> { return this.query(businessNo, ['REFUND_PAYMENT']); }
  settleDifference(operation: ProviderOperation): Promise<ProviderResult> { return this.execute(operation, 'SETTLE_DIFFERENCE'); }
  querySettlement(businessNo: string): Promise<ProviderResult> { return this.query(businessNo, ['SETTLE_DIFFERENCE']); }
  verifySignedEvent(raw: string, signature: string): VerifiedIntegrationEvent { return this.store.verifySignedEvent(raw, signature, 'payment'); }
  private async execute(operation: ProviderOperation, kind: ProviderOperation['kind']): Promise<ProviderResult> {
    this.store.assertEnabled('payment');
    if (operation.kind !== kind) throw new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Wrong operation kind for payment capability' });
    return this.store.execute(operation);
  }
  private async query(businessNo: string, kinds: ProviderOperation['kind'][]): Promise<ProviderResult> { this.store.assertEnabled('payment'); return this.store.query(businessNo, kinds); }
}
