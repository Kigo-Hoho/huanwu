import type { ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
export const LOGISTICS_PORT = Symbol('LOGISTICS_PORT');
export interface LogisticsPort {
  verifyShipment(operation: ProviderOperation): Promise<ProviderResult>;
  queryShipment(businessNo: string): Promise<ProviderResult>;
  verifyReturn(operation: ProviderOperation): Promise<ProviderResult>;
  queryReturn(operation: ProviderOperation): Promise<ProviderResult>;
  closeOrIntercept(operation: ProviderOperation): Promise<ProviderResult>;
  queryInterception(operation: ProviderOperation): Promise<ProviderResult>;
}
