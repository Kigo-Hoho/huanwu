import { Injectable } from '@nestjs/common';

import type { AuditLog, Prisma } from '../generated/prisma/client.js';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  requestId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  async record(
    tx: Prisma.TransactionClient,
    entry: AuditEntry,
  ): Promise<AuditLog> {
    const rootClient = tx as Prisma.TransactionClient & {
      $connect?: unknown;
    };
    if (typeof rootClient.$connect === 'function') {
      throw new Error(
        'AuditService.record requires an active Prisma transaction client',
      );
    }

    return await tx.auditLog.create({ data: entry });
  }
}
