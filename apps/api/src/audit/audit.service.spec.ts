import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from './audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { phase3DatabaseName, validateDatabaseName } from '../../test/phase3/support/database-fixtures.js';

describe('AuditService', () => {
  let auditService: AuditService;
  let prisma: PrismaService;
  const entityId = randomUUID();

  beforeAll(async () => {
    const name = phase3DatabaseName(process.env.DATABASE_URL!);
    expect(name.startsWith('barter_p3_')).toBe(true);
    validateDatabaseName(name, process.env.PHASE3_NAMESPACE!);
    expect(name).not.toBe(process.env.PHASE3_TEMPLATE);
    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, PrismaService],
    }).compile();
    auditService = moduleRef.get(AuditService);
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('creates an immutable audit row through the supplied transaction client', async () => {
    await prisma.$transaction(async (tx) => {
      await auditService.record(tx, {
        action: 'TASK4_AUDIT_TEST',
        entityType: 'Task4Fixture',
        entityId,
        requestId: 'task-4-request',
        before: { status: 'BEFORE' },
        after: { status: 'AFTER' },
      });
    });

    const stored = await prisma.auditLog.findFirstOrThrow({
      where: { entityId, action: 'TASK4_AUDIT_TEST' },
    });
    expect(stored).toMatchObject({
      actorId: null,
      entityType: 'Task4Fixture',
      requestId: 'task-4-request',
      before: { status: 'BEFORE' },
      after: { status: 'AFTER' },
    });
    await expect(prisma.auditLog.delete({ where: { id: stored.id } })).rejects.toThrow(/immutable/i);
    await expect(prisma.auditLog.findUnique({ where: { id: stored.id } })).resolves.toMatchObject({ id: stored.id });
  });

  it('rolls back the audit row with its surrounding transaction', async () => {
    const rolledBackEntityId = randomUUID();

    await expect(
      prisma.$transaction(async (tx) => {
        await auditService.record(tx, {
          action: 'TASK4_ROLLBACK_TEST',
          entityType: 'Task4Fixture',
          entityId: rolledBackEntityId,
        });
        throw new Error('force transaction rollback');
      }),
    ).rejects.toThrow('force transaction rollback');

    await expect(
      prisma.auditLog.findFirst({ where: { entityId: rolledBackEntityId } }),
    ).resolves.toBeNull();
  });

  it('rejects the ambient Prisma client instead of writing outside a transaction', async () => {
    const ambientEntityId = randomUUID();

    await expect(
      auditService.record(prisma, {
        action: 'TASK4_AMBIENT_WRITE_TEST',
        entityType: 'Task4Fixture',
        entityId: ambientEntityId,
      }),
    ).rejects.toThrow('active Prisma transaction client');

    await expect(
      prisma.auditLog.findFirst({ where: { entityId: ambientEntityId } }),
    ).resolves.toBeNull();
  });
});
