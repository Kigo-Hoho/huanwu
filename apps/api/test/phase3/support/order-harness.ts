import { createHmac, randomUUID } from 'node:crypto';
import { ProposalViewSchema, type OrderCommandInput, type ProposalPayer, type DeliveryMode } from '@barter/contracts';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../../../src/app.module.js';
import { AuditService } from '../../../src/audit/audit.service.js';
import type { AuthenticatedUser } from '../../../src/auth/auth.service.js';
import { CLOCK, type Clock } from '../../../src/common/clock.js';
import { PrismaService } from '../../../src/database/prisma.service.js';
import { configureApp } from '../../../src/main.js';
import { ProposalExpiryScheduler } from '../../../src/proposals/proposal-expiry.scheduler.js';
import { OrderExpiryScheduler } from '../../../src/orders/order-expiry.scheduler.js';
import { OutboxWorker } from '../../../src/integrations/outbox.worker.js';
import { createPhase3Database } from './database-fixtures.js';

export class MutableClock implements Clock {
  private value = new Date('2026-10-03T00:00:00.000Z');
  now(): Date { return new Date(this.value); }
  set(value: Date | string): void { this.value = new Date(value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}
export async function createOrderHarness() {
  const previousUrl = process.env.DATABASE_URL;
  const database = await createPhase3Database();
  const clock = new MutableClock();
  let module: TestingModule | undefined;
  let app!: INestApplication;
  let prisma!: PrismaService;
  const actors = {} as Record<'initiator' | 'recipient' | 'outsider' | 'operator' | 'mixed', AuthenticatedUser>;
  async function close(original?: unknown) {
    const failures: unknown[] = original === undefined ? [] : [original];
    vi.restoreAllMocks();
    try { if (app) await app.close(); else if (module) await module.close(); } catch (error) { failures.push(error); }
    try { if (prisma) await prisma.$disconnect(); } catch (error) { failures.push(error); }
    try { await database.close(); } catch (error) { failures.push(error); }
    finally { if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl; }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Order harness initialization or cleanup failed');
  }
  try {
    // Retain the client even if Nest compilation fails before returning a module.
    prisma = new PrismaService();
    module = await Test.createTestingModule({ imports: [AppModule.forEnvironment()] })
    .overrideProvider(PrismaService).useValue(prisma)
    .overrideProvider(CLOCK).useValue(clock)
    .overrideProvider(OutboxWorker).useValue({})
    .overrideProvider(OrderExpiryScheduler).useValue({})
    .overrideProvider(ProposalExpiryScheduler).useValue({}).compile();
  app = module.createNestApplication();
  configureApp(app); await app.init();
  for (const name of ['initiator', 'recipient', 'outsider', 'operator', 'mixed'] as const) {
    const roles: AuthenticatedUser['roles'] = name === 'operator' ? ['REVIEWER'] : name === 'mixed' ? ['CUSTOMER', 'OPERATIONS'] : ['CUSTOMER'];
    const user = await prisma.user.create({ data: {
      ...(name !== 'operator' ? { wechatOpenid: randomUUID() } : { adminCredential: { create: { email: `${randomUUID()}@example.test`, passwordHash: 'unused' } } }),
      roles: { create: roles.map(role => ({ role })) },
    } });
    actors[name] = { id: user.id, roles };
  }
  } catch (error) { await close(error); throw error; }
  function token(actor: AuthenticatedUser) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [{ alg: 'HS256', typ: 'JWT' }, { sub: actor.id, roles: actor.roles.includes('CUSTOMER') ? ['CUSTOMER'] : actor.roles, type: actor.roles.includes('CUSTOMER') ? 'CUSTOMER' : 'OPERATOR', iat: now, exp: now + 900 }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${unsigned}.${createHmac('sha256', process.env.JWT_SECRET!).update(unsigned).digest('base64url')}`;
  }
  const command = (actor: AuthenticatedUser, path: string, input: object, key: string = randomUUID()) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token(actor)}`).set('Idempotency-Key', key).send(input);
  const get = (actor: AuthenticatedUser, path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token(actor)}`);
  async function confirmedProposal(options: { offeredCount?: number; mode?: DeliveryMode; differenceFen?: number; payer?: ProposalPayer } = {}) {
    const makeItem = async (ownerId: string) => (await prisma.item.create({ data: {
      ownerId, status: 'ACTIVE', version: 3, title: '完整物品标题', description: '确认报价中的完整描述', condition: 'GOOD', referenceValueFen: 2000, wantedText: '想换咖啡机',
      images: { create: [2, 1, 3].map((n, sortOrder) => ({ url: `https://example.test/${n}.jpg`, sortOrder })) },
    } })).id;
    const offeredItemIds = [];
    for (let i = 0; i < (options.offeredCount ?? 1); i++) offeredItemIds.push(await makeItem(actors.initiator.id));
    const targetItemId = await makeItem(actors.recipient.id);
    const mode = options.mode ?? 'COURIER';
    const created = await command(actors.initiator, '/api/proposals', { offeredItemIds, targetItemId, differenceFen: options.differenceFen ?? 0, payer: options.payer ?? 'NONE', deliveryMode: mode, initiatorShippingFen: mode === 'COURIER' ? 500 : 0, recipientShippingFen: mode === 'COURIER' ? 600 : 0 }).expect(201);
    const proposal = ProposalViewSchema.parse(created.body);
    return ProposalViewSchema.parse((await command(actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: proposal.version }).expect(200)).body);
  }
  return {
    app, prisma, clock, actors, command, get, confirmedProposal,
    convert: (proposal: { id: string; version: number }, actor = actors.initiator, key?: string) => command(actor, `/api/proposals/${proposal.id}/order`, { expectedVersion: proposal.version } satisfies OrderCommandInput, key),
    faultAuditOnce(afterInsert = false) {
      const audit = app.get(AuditService); const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementationOnce(async (tx, entry) => {
        if (afterInsert) await original(tx, entry);
        throw new Error('Injected audit failure');
      });
    },
    close: () => close(),
  };
}
export type OrderHarness = Awaited<ReturnType<typeof createOrderHarness>>;
