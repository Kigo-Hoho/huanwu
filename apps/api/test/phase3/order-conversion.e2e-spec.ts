import { randomUUID } from 'node:crypto';
import { OrderCommandResultSchema } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { ReservationsService } from '../../src/reservations/reservations.service.js';
import { OrderCommandsService } from '../../src/orders/order-commands.service.js';
import { ProposalsService } from '../../src/proposals/proposals.service.js';

let h: OrderHarness;
beforeAll(async () => { h = await createOrderHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); h.clock.set('2026-10-03T00:00:00.000Z'); });

it('rechecks expiry after waiting for sorted item locks', async () => {
  const proposal = await h.confirmedProposal();
  const reservations = h.app.get(ReservationsService); const original = reservations.lockItems.bind(reservations);
  let reached!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(reservations, 'lockItems').mockImplementationOnce(async (tx, ids) => { await original(tx, ids); reached(); await resume; });
  const converting = h.convert(proposal).then(result => result);
  await arrived; h.clock.set(proposal.reservationExpiresAt!); release();
  const result = await converting;
  expect(result.status).toBe(409); expect(result.body.code).toBe('PROPOSAL_EXPIRED');
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
  expect((await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('EXPIRED');
});

it('commits shared expiry cleanup if the source expires during reservation handoff', async () => {
  const proposal = await h.confirmedProposal();
  const reservations = h.app.get(ReservationsService); const original = reservations.handoffToOrder.bind(reservations);
  vi.spyOn(reservations, 'handoffToOrder').mockImplementationOnce(async (...args) => { h.clock.set(proposal.reservationExpiresAt!); await original(...args); });
  await h.convert(proposal).expect(409).expect(({ body }) => expect(body.code).toBe('PROPOSAL_EXPIRED'));
  expect((await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('EXPIRED');
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(0);
});

it.each(['cancel', 'expiry'] as const)('serializes conversion against %s without releasing order ownership', async decision => {
  const proposal = await h.confirmedProposal();
  const reservations = h.app.get(ReservationsService); const original = reservations.lockItems.bind(reservations);
  let reached!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(reservations, 'lockItems').mockImplementationOnce(async (tx, ids) => { await original(tx, ids); reached(); await resume; });
  const converting = h.convert(proposal).then(result => result);
  await arrived;
  const competing = decision === 'cancel' ? h.command(h.actors.recipient, `/api/proposals/${proposal.id}/cancel`, { expectedVersion: proposal.version }).then(result => result.status) : h.app.get(ProposalsService).expire(proposal.id);
  release();
  const result = await converting; expect(result.status).toBe(201);
  const outcome = await competing; expect(outcome).toBe(decision === 'cancel' ? 409 : false);
  expect(await h.prisma.itemReservation.count({ where: { orderId: result.body.order.id } })).toBe(2);
});

it.each(['INACTIVE', 'owner'] as const)('rejects item %s changes while retaining confirmed snapshots', async problem => {
  const proposal = await h.confirmedProposal(); const itemId = proposal.versions[0]!.offeredItems[0]!.itemId;
  await h.prisma.item.update({ where: { id: itemId }, data: problem === 'owner' ? { ownerId: h.actors.outsider.id } : { status: 'INACTIVE' } });
  await h.convert(proposal).expect(409).expect(({ body }) => expect(body.code).toBe('ITEM_UNAVAILABLE'));
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
});

it('replays concurrent same-key conversion without duplicate audit and checks current roles on replay', async () => {
  const proposal = await h.confirmedProposal(); const key = randomUUID();
  const results = await Promise.all([h.convert(proposal, undefined, key), h.convert(proposal, undefined, key)]);
  expect(results.map(result => result.status)).toEqual([201, 201]); expect(results[0]!.body).toEqual(results[1]!.body);
  expect(await h.prisma.auditLog.count({ where: { entityId: results[0]!.body.order.id, action: 'ORDER_CREATED' } })).toBe(1);
  await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'OPERATIONS' } });
  try { await h.convert(proposal, undefined, key).expect(403); }
  finally { await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.initiator.id, role: 'OPERATIONS' } } }); }
});

it('allows disabled integrations with simulation=false and rejects new production conversion after replay', async () => {
  const first = await h.confirmedProposal(); const second = await h.confirmedProposal(); const key = randomUUID();
  const prior = { environment: process.env.NODE_ENV, payment: process.env.PAYMENT_PROVIDER, logistics: process.env.LOGISTICS_PROVIDER };
  try {
    process.env.PAYMENT_PROVIDER = 'disabled'; process.env.LOGISTICS_PROVIDER = 'disabled';
    const result = await h.convert(first, undefined, key).expect(201); expect(result.body.order.simulation).toBe(false);
    process.env.NODE_ENV = 'production';
    expect((await h.convert(first, undefined, key).expect(201)).body).toEqual(result.body);
    await h.convert(second).expect(503).expect(({ body }) => expect(body.code).toBe('INTEGRATION_UNAVAILABLE'));
  } finally {
    for (const [name, value] of Object.entries({ NODE_ENV: prior.environment, PAYMENT_PROVIDER: prior.payment, LOGISTICS_PROVIDER: prior.logistics })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

it.each(['staging', undefined])('refuses simulated new conversion in environment %s', async environment => {
  vi.stubEnv('PAYMENT_PROVIDER', 'simulated');
  vi.stubEnv('LOGISTICS_PROVIDER', 'simulated');
  const proposal = await h.confirmedProposal(); const prior = process.env.NODE_ENV;
  try {
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
    await h.convert(proposal).expect(503).expect(({ body }) => expect(body.code).toBe('INTEGRATION_UNAVAILABLE'));
    expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
  } finally { if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
});

it('executes order mutations with optimistic version, full normalized hash, safe cache and atomic audit', async () => {
  const proposal = await h.confirmedProposal(); const other = await h.confirmedProposal();
  const order = (await h.convert(proposal).expect(201)).body.order;
  const otherOrder = (await h.convert(other).expect(201)).body.order;
  const commands = h.app.get(OrderCommandsService); const key = randomUUID();
  const context = { actor: h.actors.initiator, id: order.id as string, input: { expectedVersion: 1, recipientName: 'private test name', phone: 'secret-phone' }, key, commandName: 'TEST_DETAILS', requestId: 'test-request-id' };
  const mutate = async (tx: Parameters<Parameters<typeof commands.execute>[1]>[0]) => {
    await tx.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } }, data: { addressReady: true } });
    return { auditAction: 'ORDER_DETAILS_UPDATED' };
  };
  h.faultAuditOnce(true);
  await expect(commands.execute(context, mutate)).rejects.toThrow('Injected audit failure');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(1);
  expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } } })).addressReady).toBe(false);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  const result = await commands.execute(context, mutate); expect(result.order.version).toBe(2);
  h.clock.advance(24 * 3600000);
  const reordered = { phone: 'secret-phone', recipientName: 'private test name', expectedVersion: 1 };
  const changed = { ...context.input, phone: 'changed' };
  expect(await commands.execute({ ...context, input: reordered }, mutate)).toEqual(result);
  await expect(commands.execute({ ...context, input: changed }, mutate)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  await expect(commands.execute({ ...context, id: otherOrder.id }, mutate)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  await expect(commands.execute({ ...context, key: randomUUID() }, mutate)).rejects.toMatchObject({ response: { code: 'ORDER_EXPIRED' } });
  h.clock.set('2026-10-03T00:00:00.000Z');
  await expect(commands.execute({ ...context, key: randomUUID() }, mutate)).rejects.toMatchObject({ response: { code: 'ORDER_VERSION_CONFLICT' } });
  await expect(commands.execute({ ...context, actor: h.actors.outsider }, mutate)).rejects.toMatchObject({ response: { code: 'ORDER_NOT_FOUND' } });
  await expect(commands.execute({ ...context, actor: h.actors.mixed }, mutate)).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
  const persisted = JSON.stringify({ record: await h.prisma.idempotencyRecord.findFirstOrThrow({ where: { key } }), audit: await h.prisma.auditLog.findMany({ where: { entityId: order.id, action: 'ORDER_DETAILS_UPDATED' } }) });
  expect(persisted).not.toMatch(/private test name|secret-phone|recipientName|checkoutParams/);
});

it('returns forbidden when persisted roles become mixed on a valid customer session', async () => {
  await h.get(h.actors.initiator, '/api/me').expect(200);
  await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'REVIEWER' } });
  try { await h.get(h.actors.initiator, '/api/me').expect(403); }
  finally { await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.initiator.id, role: 'REVIEWER' } } }); }
});

it('atomically converts all six immutable snapshots and preserves reservation rows', async () => {
  const proposal = await h.confirmedProposal({ offeredCount: 5, differenceFen: 1200, payer: 'RECIPIENT' });
  const leases = await h.prisma.itemReservation.findMany({ where: { proposalId: proposal.id }, orderBy: { itemId: 'asc' } });
  const first = await h.convert(proposal).expect(201);
  const { order } = OrderCommandResultSchema.parse(first.body);
  expect(order).toMatchObject({ status: 'AWAITING_DETAILS', version: 1, proposalVersionId: proposal.versions[0]!.id, terms: { differenceFen: 1200, payer: 'RECIPIENT', initiatorShippingFen: 500, recipientShippingFen: 600 }, rules: { version: 'phase3-test-v1', depositFen: 1000, feeFen: 0 }, detailsDeadline: '2026-10-04T00:00:00.000Z', paymentDeadline: null, fulfillmentDeadline: null });
  expect(order.items).toHaveLength(6);
  expect(order.items[0]).toMatchObject({ itemVersion: 3, description: '确认报价中的完整描述', imageUrls: ['https://example.test/2.jpg', 'https://example.test/1.jpg', 'https://example.test/3.jpg'] });
  const handed = await h.prisma.itemReservation.findMany({ where: { orderId: order.id }, orderBy: { itemId: 'asc' } });
  expect(handed.map(lease => ({ itemId: lease.itemId, createdAt: lease.createdAt }))).toEqual(leases.map(lease => ({ itemId: lease.itemId, createdAt: lease.createdAt })));
  expect(handed.every(lease => lease.proposalId === null && lease.proposalVersionId === null && lease.expiresAt === null)).toBe(true);
  expect((await h.get(h.actors.recipient, `/api/proposals/${proposal.id}`).expect(200)).body).toMatchObject({ status: 'CONVERTED', version: 3, orderId: order.id });
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_CREATED' } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: proposal.id, action: 'PROPOSAL_CONVERTED' } })).toBe(1);
});

it('serializes both participants into one order and exposes its id to the loser', async () => {
  const proposal = await h.confirmedProposal();
  const results = await Promise.all([h.convert(proposal), h.convert(proposal, h.actors.recipient)]);
  expect(results.map(result => result.status).sort()).toEqual([201, 409]);
  const winner = results.find(result => result.status === 201)!;
  expect(results.find(result => result.status === 409)!.body).toMatchObject({ code: 'PROPOSAL_ALREADY_CONVERTED', details: { orderId: winner.body.order.id } });
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(1);
});

it('replays original success after deadlines and rejects changed content or resource', async () => {
  const proposal = await h.confirmedProposal(); const second = await h.confirmedProposal(); const key = randomUUID();
  const first = await h.convert(proposal, undefined, key).expect(201);
  h.clock.advance(73 * 3600000);
  expect((await h.convert(proposal, undefined, key).expect(201)).body).toEqual(first.body);
  await h.command(h.actors.initiator, `/api/proposals/${proposal.id}/order`, { expectedVersion: 999 }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  await h.convert(second, undefined, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  h.clock.set('2026-10-03T00:00:00.000Z');
});

it('enforces version, pure customer, participant and strict command boundaries', async () => {
  const proposal = await h.confirmedProposal(); const path = `/api/proposals/${proposal.id}/order`;
  await h.convert(proposal, h.actors.outsider).expect(404);
  for (const actor of [h.actors.operator, h.actors.mixed]) await h.convert(proposal, actor).expect(403);
  for (const role of ['OPERATIONS', 'SUPER_ADMIN'] as const) {
    await h.prisma.userRole.create({ data: { userId: h.actors.operator.id, role } });
    await h.convert(proposal, h.actors.operator).expect(403);
  }
  await h.command(h.actors.initiator, path, { expectedVersion: 99 }).expect(409).expect(({ body }) => expect(body.code).toBe('PROPOSAL_VERSION_CONFLICT'));
  await h.command(h.actors.initiator, path, { expectedVersion: proposal.version, amountFen: 1 }).expect(400);
  await h.command(h.actors.initiator, path, { expectedVersion: proposal.version }, ' ').expect(400);
  await h.command(h.actors.initiator, `/api/orders/${randomUUID()}/acceptance`, { expectedVersion: 1 }).expect(404);
  await h.command(h.actors.initiator, `/api/orders/${randomUUID()}/issue`, { expectedVersion: 1, reason: '收到物品存在问题' }).expect(404);
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
});

it.each(['missing', 'wrong-version', 'wrong-owner', 'extra', 'deadline'] as const)('rejects %s lease without partial writes', async problem => {
  const proposal = await h.confirmedProposal();
  const itemId = proposal.versions[0]!.offeredItems[0]!.itemId;
  if (problem === 'missing') await h.prisma.itemReservation.delete({ where: { itemId } });
  if (problem === 'wrong-version' || problem === 'wrong-owner') {
    const other = await h.confirmedProposal();
    await h.prisma.itemReservation.update({ where: { itemId }, data: problem === 'wrong-version' ? { proposalVersionId: other.versions[0]!.id } : { proposalId: other.id } });
  }
  if (problem === 'extra') {
    const extra = await h.prisma.item.create({ data: { ownerId: h.actors.initiator.id, status: 'ACTIVE', title: '额外物品', description: '额外物品完整描述', referenceValueFen: 1000, condition: 'GOOD', wantedText: '' } });
    await h.prisma.itemReservation.create({ data: { itemId: extra.id, proposalId: proposal.id, proposalVersionId: proposal.versions[0]!.id, expiresAt: new Date(proposal.reservationExpiresAt!) } });
  }
  if (problem === 'deadline') await h.prisma.itemReservation.update({ where: { itemId }, data: { expiresAt: new Date(Date.parse(proposal.reservationExpiresAt!) + 1) } });
  await h.convert(proposal).expect(409).expect(({ body }) => expect(body.code).toBe('ITEM_UNAVAILABLE'));
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
  expect((await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('CONFIRMED');
});

it('expires at the inclusive boundary in an independently committed audited cleanup', async () => {
  const proposal = await h.confirmedProposal(); h.clock.set(proposal.reservationExpiresAt!);
  await h.convert(proposal).expect(409).expect(({ body }) => expect(body.code).toBe('PROPOSAL_EXPIRED'));
  expect((await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('EXPIRED');
  expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(0);
  expect(await h.prisma.auditLog.count({ where: { entityId: proposal.id, action: 'PROPOSAL_EXPIRED' } })).toBe(1);
  h.clock.set('2026-10-03T00:00:00.000Z');
});

it('rolls back a real inserted audit plus order, proposal, leases and command key', async () => {
  const proposal = await h.confirmedProposal(); const key = randomUUID(); const before = await h.prisma.auditLog.count();
  h.faultAuditOnce(true);
  await h.convert(proposal, undefined, key).expect(500);
  expect(await h.prisma.auditLog.count()).toBe(before);
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
  expect(await h.prisma.orderItemSnapshot.count({ where: { order: { proposalId: proposal.id } } })).toBe(0);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(2);
  expect((await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('CONFIRMED');
  await h.convert(proposal, undefined, key).expect(201);
});

it('starts in-person payment and keeps permanent occupancy despite old proposal expiry/cancel', async () => {
  const proposal = await h.confirmedProposal({ mode: 'IN_PERSON' });
  const result = await h.convert(proposal).expect(201);
  expect(result.body.order).toMatchObject({ status: 'AWAITING_PAYMENT', detailsDeadline: null, paymentDeadline: '2026-10-04T00:00:00.000Z' });
  h.clock.advance(73 * 3600000);
  await h.command(h.actors.recipient, `/api/proposals/${proposal.id}/cancel`, { expectedVersion: 3 }).expect(409);
  await h.get(h.actors.recipient, `/api/proposals/${proposal.id}`).expect(200);
  expect(await h.prisma.itemReservation.count({ where: { orderId: result.body.order.id } })).toBe(2);
  expect((await h.get(h.actors.initiator, `/api/items/${proposal.versions[0]!.targetItem.itemId}`).expect(200)).body.availableForProposal).toBe(false);
  h.clock.set('2026-10-03T00:00:00.000Z');
});
