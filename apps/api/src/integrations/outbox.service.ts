import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { CLOCK, type Clock } from '../common/clock.js';
import type { OutboxCommand, Prisma } from '../generated/prisma/client.js';
import type { ProviderOperation } from './integration.types.js';

@Injectable()
export class OutboxService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}
  async enqueue(tx: Prisma.TransactionClient, operation: ProviderOperation): Promise<OutboxCommand> {
    // createMany ON CONFLICT never poisons the caller's transaction on replay.
    await tx.outboxCommand.createMany({ data: [{ ...operation, availableAt: this.clock.now() }], skipDuplicates: true });
    const command = await tx.outboxCommand.findUniqueOrThrow({ where: { businessNo: operation.businessNo } });
    if (command.orderId !== operation.orderId || command.kind !== operation.kind || !isDeepStrictEqual(command.payload, operation.payload)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Integration business number already belongs to another operation' });
    }
    return command;
  }
}
