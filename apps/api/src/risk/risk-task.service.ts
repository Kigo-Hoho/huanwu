import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

export type RiskBlocker = { id: string; sourceId: string; reason: string };
export interface RiskTaskInput { sourceKey: string; kind: string; description: string; orderId?: string; caseId?: string; reportId?: string }
export async function activeBlockers(tx: Prisma.TransactionClient, orderId: string): Promise<RiskBlocker[]> {
  return tx.orderHoldBlocker.findMany({ where: { orderId, resolvedAt: null, kind: 'RISK' }, select: { id: true, sourceId: true, reason: true }, orderBy: { id: 'asc' } });
}
@Injectable()
export class RiskTaskService {
  async recordInTransaction(tx: Prisma.TransactionClient, input: RiskTaskInput): Promise<void> {
    await tx.riskTask.upsert({ where: { sourceKey: input.sourceKey }, create: input, update: {} });
  }
  activeBlockers(tx: Prisma.TransactionClient, orderId: string) { return activeBlockers(tx, orderId); }
}
