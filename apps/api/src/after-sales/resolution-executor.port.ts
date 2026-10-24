import type { ResolutionType } from '@barter/contracts';
import type { CaseMutationContext, LockedCase } from './case.types.js';

export type ExecutableResolution = LockedCase['resolutions'][number];

// Server composition only: Tasks8-10 register domain planners here. A planner
// must persist obligations/outbox in ctx.tx, never call a provider or open a
// transaction, and must not increment the caller-owned resource versions.
export interface ResolutionExecutor {
  planInTransaction(ctx: CaseMutationContext, resolution: ExecutableResolution): Promise<void>;
}
export const RESOLUTION_EXECUTORS = 'RESOLUTION_EXECUTORS';
export type ResolutionExecutors = Map<ResolutionType, ResolutionExecutor>;

export function requiresFinancialApproval(resolution: ExecutableResolution): boolean {
  // Only continuing the unchanged exchange without independent compensation is
  // exempt. Disposition/finalization plans require financial review even before
  // an original payment has been created.
  return resolution.type !== 'CONTINUE_EXCHANGE' || resolution.netCompensationFen > 0;
}
