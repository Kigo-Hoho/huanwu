import type { CaseMutationContext } from './case.types.js';
import type { ExecutableResolution } from './resolution-executor.port.js';
export interface OrderInterventionPort {
  resumeInTransaction(ctx: CaseMutationContext, resolution: ExecutableResolution): Promise<void>;
  extendDeadlineInTransaction(ctx: CaseMutationContext, input: { kind: 'DETAILS'|'PAYMENT'|'FULFILLMENT'|'ACCEPTANCE'; side?: 'INITIATOR'|'RECIPIENT' }): Promise<void>;
}
