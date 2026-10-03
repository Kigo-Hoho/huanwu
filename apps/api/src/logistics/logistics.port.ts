import type { ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
export const LOGISTICS_PORT = Symbol('LOGISTICS_PORT');
export interface LogisticsPort {
  verifyShipment(operation: ProviderOperation): Promise<ProviderResult>;
  queryShipment(businessNo: string): Promise<ProviderResult>;
}
