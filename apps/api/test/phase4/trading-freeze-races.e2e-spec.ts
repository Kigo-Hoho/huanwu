import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { activeItem, pendingProposal, riskOperator, trustedRiskOperator } from './support/risk-harness.js';
import { ReservationsService } from '../../src/reservations/reservations.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { CUSTOMER_IDENTITY_PROVIDER, type CustomerIdentityProvider } from '../../src/auth/wechat-identity.provider.js';
import { canonicalHash } from '../../src/operator-security/operator-action.types.js';

let h: AfterSalesHarness;
let desktop: Awaited<ReturnType<typeof trustedRiskOperator>>;
beforeAll(async () => { h = await createAfterSalesHarness(); desktop = await trustedRiskOperator(h); });
afterAll(async () => { await h?.close(); });
afterEach(async () => { vi.restoreAllMocks(); await h?.prisma.tradingRestriction.deleteMany(); });

it('hides frozen listings and rejects new trading while preserving owned reads and case evidence responses', async () => {
  const proposal = await pendingProposal(h);
  const order = await h.prepareOrder();
  const opened = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '争议' }).expect(201)).body;
  const item = await activeItem(h, h.actors.initiator.id);
  const reviewer = await riskOperator(h);
  await reviewer.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '交易风险待核验' }).then(r => expect(r.status).toBe(200));
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(opened.orderVersion);
  expect((await h.prisma.item.findUniqueOrThrow({ where: { id: item.id } })).version).toBe(1);
  await h.get(h.actors.recipient, `/api/items/${item.id}`).expect(404);
  expect((await h.get(h.actors.recipient, '/api/items').expect(200)).body.items.some((row: { id: string }) => row.id === item.id)).toBe(false);
  await h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: proposal.version }).expect(409).expect(r => expect(r.body.code).toBe('TRADING_FROZEN'));
  await h.get(h.actors.initiator, '/api/me/items').expect(200);
  await h.command(h.actors.initiator, `/api/after-sales/${opened.case.id}/response`, { expectedCaseVersion: opened.case.version, expectedOrderVersion: opened.orderVersion, description: '仍然可以补充事实' }).expect(200);
});
it('denies support freeze and rolls back restriction, consumed grant and audit together', async () => {
  const support = await riskOperator(h, h.actors.operations);
  await support.post(`/api/admin/risk/users/${h.actors.outsider.id}/freeze`, { expectedVersion: 1, reason: '不允许', operatorAction: { grantId: h.actors.outsider.id } }).expect(403);
  const reviewer = await riskOperator(h);
  h.faultAuditActionAfterInsertOnce('TRADING_FROZEN', async () => {});
  await reviewer.action(`/api/admin/risk/users/${h.actors.outsider.id}/freeze`, 'FREEZE_TRADING', h.actors.outsider.id, { expectedVersion: 1, reason: '核验' }).then(r => expect(r.status).toBe(500));
  expect(await h.prisma.tradingRestriction.findUnique({ where: { userId: h.actors.outsider.id } })).toBeNull();
});
it('risk-unpublishes one item with an independent blocker and cannot edit it back onto the market', async () => {
  const item = await activeItem(h);
  const reviewer = await riskOperator(h);
  await reviewer.action(`/api/admin/risk/items/${item.id}/unpublish`, 'UNPUBLISH_ITEM', item.id, { expectedVersion: 1, reason: '违禁风险' }).then(r => expect(r.status).toBe(200));
  expect(await h.prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: 'INACTIVE', version: 2 });
  expect(await h.prisma.riskTask.count({ where: { sourceKey: `item:${item.id}`, status: 'OPEN' } })).toBe(1);
  await h.command(h.actors.outsider, `/api/items/${item.id}/submit`, {}).expect(404);
  await h.command(h.actors.recipient, `/api/items/${item.id}/submit`, {}).expect(409);
});
it('serializes freeze against accept and conversion without partial reservations', async () => {
  const proposal = await pendingProposal(h);
  const reviewer = await riskOperator(h);
  const results = await Promise.all([
    reviewer.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '并发核验' }),
    h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: 1 }),
  ]);
  expect(results[0].status).toBe(200);
  expect([200, 409]).toContain(results[1].status);
  const stored = await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
  expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(stored.status === 'CONFIRMED' ? 2 : 0);
  if (stored.status === 'CONFIRMED') await h.convert({ id: proposal.id, version: stored.version }).expect(409).expect(r => expect(r.body.code).toBe('TRADING_FROZEN'));
});
it('requires desktop restoration, preserves unpublished state on unfreeze and requires review after item clearance', async () => {
  const item = await activeItem(h);
  const mobile = await riskOperator(h);
  await mobile.action(`/api/admin/risk/items/${item.id}/unpublish`, 'UNPUBLISH_ITEM', item.id, { expectedVersion: 1, reason: '独立物品风险' }).then(r => expect(r.status).toBe(200));
  await mobile.action(`/api/admin/risk/users/${item.ownerId}/freeze`, 'FREEZE_TRADING', item.ownerId, { expectedVersion: 1, reason: '用户交易风险' }).then(r => expect(r.status).toBe(200));
  await h.grant(mobile.session, { action: 'UNFREEZE_TRADING', resourceId: item.ownerId, expectedVersions: { expectedVersion: 2 }, requestHash: 'a'.repeat(64) }).expect(403);
  await h.grant(mobile.session, { action: 'CLEAR_ITEM_RISK', resourceId: item.id, expectedVersions: { expectedVersion: 2 }, requestHash: 'a'.repeat(64) }).expect(403);
  await desktop.action(`/api/admin/risk/users/${item.ownerId}/unfreeze`, 'UNFREEZE_TRADING', item.ownerId, { expectedVersion: 2, reason: '解除用户交易风险' }).then(r => expect(r.status).toBe(200));
  expect((await h.prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('INACTIVE');
  const edit = () => request(h.app.getHttpServer()).patch(`/api/items/${item.id}`).set('Authorization', `Bearer ${h.token(h.actors.recipient)}`).send({ title: '重新编辑后的物品标题' });
  await edit().expect(409);
  await desktop.action(`/api/admin/risk/items/${item.id}/clear-block`, 'CLEAR_ITEM_RISK', item.id, { expectedVersion: 2, reason: '证据核验完成' }).then(r => expect(r.status).toBe(200));
  expect((await h.prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('INACTIVE');
  await h.get(h.actors.initiator, `/api/items/${item.id}`).expect(404);
  await h.command(h.actors.recipient, `/api/items/${item.id}/submit`, {}).expect(409);
  await edit().expect(200).expect(r => expect(r.body.status).toBe('DRAFT'));
  await h.command(h.actors.recipient, `/api/items/${item.id}/submit`, {}).expect(200).expect(r => expect(r.body.status).toBe('PENDING_REVIEW'));
  await h.get(h.actors.initiator, `/api/items/${item.id}`).expect(404);
});
it('clears only the selected risk blocker without resuming an order or clearing its after-sales blocker', async () => {
  const order = await h.prepareOrder();
  const opened = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '争议' }).expect(201)).body;
  await desktop.action(`/api/admin/risk/orders/${order.id}/pause`, 'HOLD_ORDER', order.id, { expectedVersion: opened.orderVersion, reason: '独立核验' }).then(r => expect(r.status).toBe(200));
  const blocker = await h.prisma.orderHoldBlocker.findFirstOrThrow({ where: { orderId: order.id, kind: 'RISK' } });
  const clear = { expectedVersion: 3, reason: '该项核验完成', blockerId: blocker.id };
  await desktop.action(`/api/admin/risk/orders/${order.id}/clear-block`, 'CLEAR_ORDER_RISK', order.id, clear).then(r => expect(r.status).toBe(200));
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'ON_HOLD', holdReason: '争议', version: 4 });
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id, kind: 'CASE', resolvedAt: null } })).toBe(1);
  const caseBlocker = await h.prisma.orderHoldBlocker.findFirstOrThrow({ where: { orderId: order.id, kind: 'CASE' } });
  await desktop.action(`/api/admin/risk/orders/${order.id}/clear-block`, 'CLEAR_ORDER_RISK', order.id, { ...clear, expectedVersion: 4, blockerId: caseBlocker.id }).then(r => expect(r.status).toBe(409));
});
it('blocks new drafts, submissions, creates and counters for either frozen participant but still permits login', async () => {
  const pending = await pendingProposal(h);
  const item = await activeItem(h, h.actors.initiator.id);
  const draft = await h.prisma.item.create({ data: { ownerId: h.actors.recipient.id, title: '草稿物品标题', description: '草稿描述', referenceValueFen: 1000, condition: 'GOOD', wantedText: '换物', images: { create: [0, 1, 2].map(sortOrder => ({ sortOrder, url: `https://example.test/${sortOrder}.jpg` })) } } });
  const input = { title: '新建发布物品标题', description: '完整发布物品描述', referenceValueFen: 1000, condition: 'GOOD', wantedText: '换物', imageUrls: [0, 1, 2].map(i => `https://example.test/${i}.jpg`) };
  await desktop.action(`/api/admin/risk/users/${h.actors.recipient.id}/freeze`, 'FREEZE_TRADING', h.actors.recipient.id, { expectedVersion: 1, reason: '核验' }).then(r => expect(r.status).toBe(200));
  await h.command(h.actors.recipient, '/api/items', input).expect(409).expect(r => expect(r.body.code).toBe('TRADING_FROZEN'));
  await h.command(h.actors.recipient, `/api/items/${draft.id}/submit`, {}).expect(409);
  await h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: [item.id], targetItemId: draft.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(409).expect(r => expect(r.body.code).toBe('TRADING_FROZEN'));
  const current = (await h.get(h.actors.recipient, `/api/proposals/${pending.id}`).expect(200)).body.versions[0];
  await h.command(h.actors.recipient, `/api/proposals/${pending.id}/counter`, { expectedVersion: 1, offeredItemIds: current.offeredItems.map((v: { itemId: string }) => v.itemId), targetItemId: current.targetItem.itemId, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(409);
  const user = await h.prisma.user.findUniqueOrThrow({ where: { id: h.actors.recipient.id } });
  vi.spyOn(h.app.get<CustomerIdentityProvider>(CUSTOMER_IDENTITY_PROVIDER), 'exchangeCode').mockResolvedValue({ openid: user.wechatOpenid! });
  await request(h.app.getHttpServer()).post('/api/auth/wechat').send({ code: 'owned-test-identity' }).expect(201);
});
async function observeRestrictionWait() {
  for (let i = 0; i < 100; i++) {
    const rows = await h.prisma.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%TradingRestriction%') AS waiting`;
    if (rows[0]?.waiting) return true;
    await delay(10);
  }
  return false;
}
it('holds freeze behind a trading command that already owns restriction rows, including their first insertion', async () => {
  const proposal = await pendingProposal(h);
  // Exercise an account pair that has never yet had a restriction baseline.
  await h.prisma.tradingRestriction.deleteMany();
  let reached!: () => void; let release!: () => void;
  const atItems = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const reservations = h.app.get(ReservationsService); const original = reservations.lockItems.bind(reservations);
  vi.spyOn(reservations, 'lockItems').mockImplementationOnce(async (tx, ids) => { reached(); await resume; return original(tx, ids); });
  const accepting = h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: 1 }).then(r => r);
  await atItems;
  const freezing = desktop.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '并发核验' });
  let waiting: boolean;
  try { waiting = await observeRestrictionWait(); }
  finally { release(); }
  expect((await accepting).status).toBe(200);
  expect((await freezing).status).toBe(200);
  expect(waiting).toBe(true);
  expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(2);
});
it.each(['accept', 'convert'] as const)('waits for a first freeze to commit before %s and then rejects without partial writes', async kind => {
  let proposal = await pendingProposal(h);
  if (kind === 'convert') proposal = (await h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: 1 }).expect(200)).body;
  await h.prisma.tradingRestriction.deleteMany();
  let reached!: () => void; let release!: () => void;
  const updated = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const row = await original(tx, entry); if (entry.action === 'TRADING_FROZEN') { reached(); await resume; } return row; });
  const freezing = desktop.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '首次冻结核验' });
  await updated;
  const trading = (kind === 'accept' ? h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: proposal.version }) : h.convert(proposal)).then(r => r);
  let waiting: boolean;
  try { waiting = await observeRestrictionWait(); }
  finally { release(); }
  expect((await freezing).status).toBe(200);
  expect(await trading).toMatchObject({ status: 409, body: { code: 'TRADING_FROZEN' } });
  expect(waiting).toBe(true);
  expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(kind === 'convert' ? 2 : 0);
});
it('reads a restriction version through an independent minimal risk-only projection', async () => {
  const path = `/api/admin/risk/users/${h.actors.outsider.id}`;
  await h.get(h.actors.outsider, path).expect(403);
  const support = await riskOperator(h, h.actors.operations);
  await support.get(path).expect(403);
  expect((await desktop.get(path).expect(200)).body).toEqual({ status: 'CLEAR', version: 1, reason: null });
  await desktop.action(`${path}/freeze`, 'FREEZE_TRADING', h.actors.outsider.id, { expectedVersion: 1, reason: '交易核验' }).then(r => expect(r.status).toBe(200));
  expect((await desktop.get(path).expect(200)).body).toEqual({ status: 'FROZEN', version: 2, reason: '交易核验' });
  await desktop.get(`/api/admin/risk/users/${randomUUID()}`).expect(404);
});
it.each([
  ['unpublish', 'UNPUBLISH_ITEM', 'RISK_ITEM_UNPUBLISHED'], ['pause', 'HOLD_ORDER', 'RISK_ORDER_PAUSED'],
  ['clearItem', 'CLEAR_ITEM_RISK', 'RISK_ITEM_CLEARED'], ['clearOrder', 'CLEAR_ORDER_RISK', 'RISK_ORDER_CLEARED'],
  ['unfreeze', 'UNFREEZE_TRADING', 'TRADING_UNFROZEN'],
] as const)('rolls back %s business writes and grant consumption on final audit failure, and reuses the same logical command', async (command, action, auditAction) => {
  const isItem = command === 'unpublish' || command === 'clearItem';
  const isUser = command === 'unfreeze';
  const resource = isItem ? await activeItem(h) : isUser ? { id: h.actors.outsider.id, version: 1 } : await h.prepareOrder();
  let expectedVersion = resource.version;
  if (command === 'clearItem') { expect((await desktop.action(`/api/admin/risk/items/${resource.id}/unpublish`, 'UNPUBLISH_ITEM', resource.id, { expectedVersion, reason: '初始阻塞' })).status).toBe(200); expectedVersion++; }
  if (command === 'clearOrder') { expect((await desktop.action(`/api/admin/risk/orders/${resource.id}/pause`, 'HOLD_ORDER', resource.id, { expectedVersion, reason: '初始阻塞' })).status).toBe(200); expectedVersion++; }
  if (isUser) { expect((await desktop.action(`/api/admin/risk/users/${resource.id}/freeze`, 'FREEZE_TRADING', resource.id, { expectedVersion, reason: '初始冻结' })).status).toBe(200); expectedVersion++; }
  const blocker = command === 'clearOrder' ? await h.prisma.orderHoldBlocker.findFirstOrThrow({ where: { orderId: resource.id, kind: 'RISK' } }) : null;
  const business = { expectedVersion, reason: '有证据的单项操作', ...(blocker ? { blockerId: blocker.id } : {}) };
  const grant = await h.grant(desktop.session, { action, resourceId: resource.id, expectedVersions: { expectedVersion }, requestHash: canonicalHash(business) }).expect(200);
  const input = { ...business, operatorAction: { sessionId: desktop.session.response.body.operatorSession.id, grantId: grant.body.id } };
  const path = `/api/admin/risk/${isItem ? 'items' : isUser ? 'users' : 'orders'}/${resource.id}/${command.startsWith('clear') ? 'clear-block' : command}`;
  const before = { items: await h.prisma.item.findMany({ where: { id: resource.id } }), orders: await h.prisma.order.findMany({ where: { id: resource.id } }), restrictions: await h.prisma.tradingRestriction.findMany({ where: { userId: resource.id } }), tasks: await h.prisma.riskTask.findMany({ orderBy: { id: 'asc' } }), blockers: await h.prisma.orderHoldBlocker.findMany({ orderBy: { id: 'asc' } }), records: await h.prisma.riskRecord.count(), audits: await h.prisma.auditLog.count() };
  const key = randomUUID();
  h.faultAuditActionAfterInsertOnce(auditAction, async tx => { expect(await tx.auditLog.count({ where: { action: auditAction, entityId: resource.id } })).toBeGreaterThan(0); });
  await desktop.post(path, input, key).expect(500);
  expect({ items: await h.prisma.item.findMany({ where: { id: resource.id } }), orders: await h.prisma.order.findMany({ where: { id: resource.id } }), restrictions: await h.prisma.tradingRestriction.findMany({ where: { userId: resource.id } }), tasks: await h.prisma.riskTask.findMany({ orderBy: { id: 'asc' } }), blockers: await h.prisma.orderHoldBlocker.findMany({ orderBy: { id: 'asc' } }), records: await h.prisma.riskRecord.count(), audits: await h.prisma.auditLog.count() }).toEqual(before);
  expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: grant.body.id } })).consumedAt).toBeNull();
  expect(await h.prisma.idempotencyRecord.count({ where: { actorId: h.actors.reviewer.id, key } })).toBe(0);
  await desktop.post(path, input, key).expect(200);
  await desktop.post(path, input, key).expect(200);
  expect(await h.prisma.auditLog.count({ where: { action: auditAction, entityId: resource.id } })).toBe(1);
});
it('fails closed for a legacy risk blocker without provable task provenance', async () => {
  const order = await h.prepareOrder();
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: '历史导入风险', heldAt: h.clock.now(), holdPreviousStatus: 'AWAITING_DETAILS' } });
  const blocker = await h.prisma.orderHoldBlocker.create({ data: { orderId: order.id, kind: 'RISK', sourceId: 'hold:LEGACY_IMPORTED_REASON', reason: '历史导入风险' } });
  expect((await desktop.action(`/api/admin/risk/orders/${order.id}/clear-block`, 'CLEAR_ORDER_RISK', order.id, { expectedVersion: 1, reason: '不能猜测来源', blockerId: blocker.id })).status).toBe(409);
  expect((await h.prisma.orderHoldBlocker.findUniqueOrThrow({ where: { id: blocker.id } })).resolvedAt).toBeNull();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(1);
});
