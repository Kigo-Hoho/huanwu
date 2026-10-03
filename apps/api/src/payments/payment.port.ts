import type { ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
export const PAYMENT_PORT = Symbol('PAYMENT_PORT');
export interface PaymentPort {
  createPayment(operation: ProviderOperation): Promise<ProviderResult>;
  queryPayment(businessNo: string): Promise<ProviderResult>;
  closePayment(operation: ProviderOperation): Promise<ProviderResult>;
  refundPayment(operation: ProviderOperation): Promise<ProviderResult>;
  queryRefund(businessNo: string): Promise<ProviderResult>;
  settleDifference(operation: ProviderOperation): Promise<ProviderResult>;
  querySettlement(businessNo: string): Promise<ProviderResult>;
}
