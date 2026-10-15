import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class TradingRestrictionsService {
  // These baseline rows serialize even a user's first trade against their first
  // freeze. Call before proposal/order/item locks, including conversion callers.
  async lock(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
    for (const userId of [...new Set(userIds)].sort()) {
      await tx.tradingRestriction.createMany({ data: [{ userId }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "userId" FROM "TradingRestriction" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    }
  }
  async lockAndAssert(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
    await this.lock(tx, userIds);
    await this.assertAllowed(tx, userIds);
  }
  // Callers already hold these restriction rows. Saved-command recovery is not
  // new admission and must be checked before calling this assertion.
  async assertAllowed(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
    if (await tx.tradingRestriction.count({ where: { userId: { in: userIds }, status: 'FROZEN' } })) {
      throw new ConflictException({ code: 'TRADING_FROZEN', message: 'New trading is restricted; existing records and after-sales remain available' });
    }
  }
  async assertItemClear(tx: Prisma.TransactionClient, itemId: string): Promise<void> {
    const blocker = await tx.riskTask.findUnique({ where: { sourceKey: `item:${itemId}` } });
    if (blocker && blocker.status !== 'RESOLVED') throw new ConflictException({ code: 'RISK_BLOCKS_RESUME', message: 'Item risk must be cleared before editing or submitting' });
  }
}
