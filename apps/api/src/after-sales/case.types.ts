import type { CaseCommandInput } from '@barter/contracts';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { LockedOrder } from '../orders/order.mapper.js';

export const caseInclude = {
  records: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  evidence: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  resolutions: { orderBy: { number: 'asc' }, include: { consents: true, approvals: true, executions: { include: { progress: true } }, returnObligations: { include: { progress: true } }, compensationObligations: { include: { progress: true, payment: true } } } },
} satisfies Prisma.AfterSalesCaseInclude;
export type CaseTx = Prisma.TransactionClient;
export type LockedCase = Prisma.AfterSalesCaseGetPayload<{ include: typeof caseInclude }>;
export interface CaseMutationContext { tx: CaseTx; order: LockedOrder; case: LockedCase; now: Date; actor: AuthenticatedUser | null }
export interface CaseCommandContext { actor: AuthenticatedUser; caseId: string; input: CaseCommandInput; key: string; commandName: string; requestId?: string }
