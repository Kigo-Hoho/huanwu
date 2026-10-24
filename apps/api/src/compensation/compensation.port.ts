import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
import { SimulatedProviderStore } from '../integrations/simulated-provider.store.js';
export const COMPENSATION_PORT = Symbol('COMPENSATION_PORT');
export interface CompensationPort {
  create(operation: ProviderOperation): Promise<ProviderResult>;
  query(businessNo: string): Promise<ProviderResult>;
  close(operation: ProviderOperation): Promise<ProviderResult>;
  refund(operation: ProviderOperation): Promise<ProviderResult>;
  queryRefund(businessNo: string): Promise<ProviderResult>;
  disburse(operation: ProviderOperation): Promise<ProviderResult>;
  queryDisbursement(businessNo: string): Promise<ProviderResult>;
}
@Injectable()
export class SimulatedCompensationAdapter implements CompensationPort {
  constructor(@Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore) {}
  create(op: ProviderOperation) { return this.execute(op, 'CREATE_COMPENSATION'); }
  close(op: ProviderOperation) { return this.execute(op, 'CLOSE_COMPENSATION'); }
  refund(op: ProviderOperation) { return this.execute(op, 'REFUND_COMPENSATION'); }
  disburse(op: ProviderOperation) { return this.execute(op, 'DISBURSE_COMPENSATION'); }
  query(no: string) { this.store.assertEnabled('payment'); return this.store.query(no, ['CREATE_COMPENSATION', 'CLOSE_COMPENSATION']); }
  queryRefund(no: string) { this.store.assertEnabled('payment'); return this.store.query(no, ['REFUND_COMPENSATION']); }
  queryDisbursement(no: string) { this.store.assertEnabled('payment'); return this.store.query(no, ['DISBURSE_COMPENSATION']); }
  private execute(op: ProviderOperation, kind: ProviderOperation['kind']) { this.store.assertEnabled('payment'); if (op.kind !== kind) throw new BadRequestException('Wrong compensation operation'); return this.store.execute(op); }
}
