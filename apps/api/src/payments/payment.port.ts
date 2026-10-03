import type { ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
import type { CheckoutView } from '@barter/contracts';
export const PAYMENT_PORT = Symbol('PAYMENT_PORT');
export interface PaymentPort {
  checkout?(businessNo: string): Promise<CheckoutView>;
  createPayment(operation: ProviderOperation): Promise<ProviderResult>;
  queryPayment(businessNo: string): Promise<ProviderResult>;
  closePayment(operation: ProviderOperation): Promise<ProviderResult>;
  refundPayment(operation: ProviderOperation): Promise<ProviderResult>;
  queryRefund(businessNo: string): Promise<ProviderResult>;
  settleDifference(operation: ProviderOperation): Promise<ProviderResult>;
  querySettlement(businessNo: string): Promise<ProviderResult>;
}
