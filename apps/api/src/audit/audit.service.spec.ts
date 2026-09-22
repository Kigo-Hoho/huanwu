import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from './audit.service.js';
import { PrismaService } from '../database/prisma.service.js';

describe('AuditService', () => {
  let auditService: AuditService;
  let prisma: PrismaService;
  const entityId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, PrismaService],
    }).compile();
    auditService = moduleRef.get(AuditService);
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { entityType: 'Task4Fixture' },
    });
    await prisma.$disconnect();
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
