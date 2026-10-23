import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { activeItem, pendingProposal, riskOperator, trustedRiskOperator } from './support/risk-harness.js';
import { ReservationsService } from '../../src/reservations/reservations.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { TradingRestrictionsService } from '../../src/risk/trading-restrictions.service.js';
import { CUSTOMER_IDENTITY_PROVIDER, type CustomerIdentityProvider } from '../../src/auth/wechat-identity.provider.js';
import { canonicalHash } from '../../src/operator-security/operator-action.types.js';

let h: AfterSalesHarness;
let desktop: Awaited<ReturnType<typeof trustedRiskOperator>>;
beforeAll(async () => { h = await createAfterSalesHarness(); desktop = await trustedRiskOperator(h); });
afterAll(async () => { await h?.close(); });
afterEach(async () => { vi.restoreAllMocks(); await h?.prisma.tradingRestriction.deleteMany(); });
async function taskFromHttp(orderId: string) {
  let cursor: string | null = null;
  do {
    const page: { items: { id: string; orderId: string | null; kind: string }[]; nextCursor: string | null } = (await desktop.get(`/api/admin/risk-tasks?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200)).body;
    const task = page.items.find(value => value.orderId === orderId && value.kind === 'OPERATOR_ORDER_PAUSE');
    if (task) return (await desktop.get(`/api/admin/risk-tasks/${task.id}`).expect(200)).body as { id: string; blockerId: string | null; orderId: string; status: string };
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error('Expected paused order task from the authorized HTTP reader');
}

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
  const task = await taskFromHttp(order.id);
  expect(task.blockerId).toEqual(expect.any(String));
  expect(task.blockerId).not.toBe(task.id);
  const current = (await desktop.get(`/api/admin/orders/${order.id}`).expect(200)).body;
  const clear = { expectedVersion: current.version, reason: '该项核验完成', blockerId: task.blockerId! };
  await desktop.action(`/api/admin/risk/orders/${order.id}/clear-block`, 'CLEAR_ORDER_RISK', order.id, clear).then(r => expect(r.status).toBe(200));
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'ON_HOLD', holdReason: '争议', version: 4 });
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id, kind: 'CASE', resolvedAt: null } })).toBe(1);
  expect((await taskFromHttp(order.id)).blockerId).toBeNull();
  await desktop.action(`/api/admin/risk/orders/${order.id}/clear-block`, 'CLEAR_ORDER_RISK', order.id, { ...clear, expectedVersion: 4, blockerId: task.id }).then(r => expect(r.status).toBe(409));
});
it('blocks new drafts, submissions, creates and counters for either frozen participant but still permits login', async () => {
  const pending = await pendingProposal(h);
  const item = await activeItem(h, h.actors.initiator.id);
  const draft = await h.prisma.item.create({ data: { ownerId: h.actors.recipient.id, title: '草稿物品标题', description: '草稿描述', referenceValueFen: 1000, condition: 'GOOD', wantedText: '换物', images: { create: [0, 1, 2].map(sortOrder => ({ sortOrder, url: `https://example.test/${sortOrder}.jpg` })) } } });
  const publicTarget = await activeItem(h);
  const input = { title: '新建发布物品标题', description: '完整发布物品描述', referenceValueFen: 1000, condition: 'GOOD', wantedText: '换物', imageUrls: [0, 1, 2].map(i => `https://example.test/${i}.jpg`) };
  await desktop.action(`/api/admin/risk/users/${h.actors.recipient.id}/freeze`, 'FREEZE_TRADING', h.actors.recipient.id, { expectedVersion: 1, reason: '核验' }).then(r => expect(r.status).toBe(200));
  await h.command(h.actors.recipient, '/api/items', input).expect(409).expect(r => expect(r.body.code).toBe('TRADING_FROZEN'));
  await h.command(h.actors.recipient, `/api/items/${draft.id}/submit`, {}).expect(409);
  await h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: [item.id], targetItemId: publicTarget.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(409).expect(r => expect(r.body.code).toBe('ITEM_UNAVAILABLE'));
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
  const freezeAtLock = Promise.withResolvers<void>();
  const restrictions = h.app.get(TradingRestrictionsService); const realLock = restrictions.lock.bind(restrictions);
  vi.spyOn(restrictions, 'lock').mockImplementationOnce(async (tx, ids) => {
    // Deliberate arrival latency exceeds the unchanged observer window: this
    // catches starting observation during grant/HTTP scheduling, before locking.
    await delay(1500);
    freezeAtLock.resolve();
    return realLock(tx, ids);
  });
  const freezing = desktop.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '并发核验' });
  let waiting: boolean;
  try {
    await Promise.race([freezeAtLock.promise, freezing.then(() => { throw new Error('Freeze bypassed the restriction lock'); })]);
    waiting = await observeRestrictionWait();
  }
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
  const task = command === 'clearOrder' ? await taskFromHttp(resource.id) : null;
  const business = { expectedVersion, reason: '有证据的单项操作', ...(task ? { blockerId: task.blockerId! } : {}) };
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
it('exposes no actionable blocker for terminal, resolved, ineligible or cross-order task associations', async () => {
  const order = await h.prepareOrder(); const other = await h.prepareOrder();
  const support = await riskOperator(h, h.actors.operations);
  for (const [kind, status, taskOrderId] of [
    ['ITEM_UNPUBLISHED', 'OPEN', order.id],
    ['OPERATOR_ORDER_PAUSE', 'OPEN', other.id],
    ['SHIPMENT_EXCEPTION', 'RESOLVED', order.id],
  ] as const) {
    // Build malformed/imported association fixtures only; all identifiers used
    // by the positive clearance workflow above come from public API responses.
    const task = await h.prisma.riskTask.create({ data: { orderId: taskOrderId, kind, sourceKey: randomUUID(), description: '投影边界夹具', status } });
    await h.prisma.orderHoldBlocker.create({ data: { orderId: order.id, kind: 'RISK', sourceId: task.id, reason: '投影边界夹具' } });
    const detail = await desktop.get(`/api/admin/risk-tasks/${task.id}`).expect(200);
    expect(detail.body.blockerId).toBeNull();
    await support.get(`/api/admin/risk-tasks/${task.id}`).expect(403);
    await h.get(h.actors.outsider, `/api/admin/risk-tasks/${task.id}`).expect(403);
  }
  await desktop.action(`/api/admin/risk/orders/${other.id}/pause`, 'HOLD_ORDER', other.id, { expectedVersion: 1, reason: '先合法暂停' }).then(r => expect(r.status).toBe(200));
  const actionable = await taskFromHttp(other.id);
  // A historical terminal transition must make a previously visible blocker
  // non-actionable, including when a client retained its earlier identifier.
  await h.prisma.order.update({ where: { id: other.id }, data: { status: 'COMPLETED' } });
  expect((await desktop.get(`/api/admin/risk-tasks/${actionable.id}`).expect(200)).body.blockerId).toBeNull();
  expect((await desktop.get('/api/admin/risk-tasks?limit=50').expect(200)).body.items.find((row: { id: string }) => row.id === actionable.id).blockerId).toBeNull();
  await desktop.action(`/api/admin/risk/orders/${other.id}/clear-block`, 'CLEAR_ORDER_RISK', other.id, { expectedVersion: 2, reason: '不能清除终态', blockerId: actionable.blockerId! }).then(r => expect(r.status).toBe(409));
});
async function tradingSnapshot() {
  return {
    items: await h.prisma.item.findMany({ orderBy: { id: 'asc' } }),
    proposals: await h.prisma.proposal.findMany({ orderBy: { id: 'asc' } }),
    versions: await h.prisma.proposalVersion.count(),
    orders: await h.prisma.order.findMany({ orderBy: { id: 'asc' } }),
    leases: await h.prisma.itemReservation.findMany({ orderBy: { itemId: 'asc' } }),
    audits: await h.prisma.auditLog.count(),
    commands: await h.prisma.idempotencyRecord.count(),
  };
}
it.each([
  ['submit', 'initiator'], ['create', 'initiator'], ['create', 'recipient'],
  ['counter', 'initiator'], ['counter', 'recipient'], ['accept', 'initiator'], ['accept', 'recipient'],
  ['convert', 'initiator'], ['convert', 'recipient'],
] as const)('preserves saved-command recovery for %s after freezing %s without admitting a new trade', async (kind, frozenSide) => {
  const offered = await activeItem(h, h.actors.initiator.id); const target = await activeItem(h);
  const offer = { offeredItemIds: [offered.id], targetItemId: target.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 };
  let path = '/api/proposals'; let actor = h.actors.initiator; let input: Record<string, unknown> = offer; let status = 201;
  if (kind === 'submit') {
    await h.prisma.item.update({ where: { id: offered.id }, data: { status: 'DRAFT' } });
    path = `/api/items/${offered.id}/submit`; input = {}; status = 200;
  } else if (kind !== 'create') {
    let proposal = (await h.command(h.actors.initiator, '/api/proposals', offer).expect(201)).body;
    if (kind === 'convert') proposal = (await h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: proposal.version }).expect(200)).body;
    path = `/api/proposals/${proposal.id}/${kind === 'convert' ? 'order' : kind}`;
    actor = kind === 'convert' ? h.actors.initiator : h.actors.recipient;
    input = { ...(kind === 'counter' ? offer : {}), expectedVersion: proposal.version }; status = kind === 'convert' ? 201 : 200;
  }
  const key = randomUUID(); const saved = (await h.command(actor, path, input, key).expect(status)).body;
  // Submit has no body fields; another owned item is its changed resource.
  const otherDraft = kind === 'submit' ? await h.prisma.item.create({ data: { ownerId: actor.id, title: '另一件草稿物品', description: '同键不能跨资源', condition: 'GOOD', referenceValueFen: 1000, wantedText: '换物' } }) : null;
  const frozen = h.actors[frozenSide];
  expect((await desktop.action(`/api/admin/risk/users/${frozen.id}/freeze`, 'FREEZE_TRADING', frozen.id, { expectedVersion: 1, reason: '提交后独立风险' })).status).toBe(200);
  const before = await tradingSnapshot();
  expect((await h.command(actor, path, input, key).expect(status)).body).toEqual(saved);
  expect(await tradingSnapshot()).toEqual(before);
  const altered = kind === 'create' || kind === 'counter' ? { ...input, differenceFen: 100, payer: 'INITIATOR' } : { ...input, expectedVersion: Number(input.expectedVersion) + 1 };
  await h.command(actor, otherDraft ? `/api/items/${otherDraft.id}/submit` : path, otherDraft ? {} : altered, key).expect(409).expect(r => expect(r.body.code).toBe('IDEMPOTENCY_CONFLICT'));
  await h.command(actor, path, input).expect(409);
  await h.command(h.actors.outsider, path, input, key).expect(kind === 'create' ? 409 : 404);
  expect(await tradingSnapshot()).toEqual(before);
});
it('preserves legacy null-hash submit recovery while keeping its saved resource binding', async () => {
  const item = await activeItem(h, h.actors.initiator.id);
  await h.prisma.item.update({ where: { id: item.id }, data: { status: 'DRAFT' } });
  const key = randomUUID(); const path = `/api/items/${item.id}/submit`;
  const saved = (await h.command(h.actors.initiator, path, {}, key).expect(200)).body;
  await h.prisma.idempotencyRecord.update({ where: { actorId_commandName_key: { actorId: h.actors.initiator.id, commandName: 'SUBMIT_ITEM', key } }, data: { requestHash: null } });
  const other = await activeItem(h, h.actors.initiator.id);
  expect((await desktop.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '历史命令仍可恢复' })).status).toBe(200);
  const before = await tradingSnapshot();
  expect((await h.command(h.actors.initiator, path, {}, key).expect(200)).body).toEqual(saved);
  await h.command(h.actors.initiator, `/api/items/${other.id}/submit`, {}, key).expect(409).expect(r => expect(r.body.code).toBe('IDEMPOTENCY_CONFLICT'));
  expect(await tradingSnapshot()).toEqual(before);
});
it('waits behind a concurrent freeze and then returns the saved acceptance without new writes', async () => {
  const proposal = await pendingProposal(h); const key = randomUUID();
  const path = `/api/proposals/${proposal.id}/accept`; const input = { expectedVersion: proposal.version };
  const saved = (await h.command(h.actors.recipient, path, input, key).expect(200)).body;
  const state = async () => ({ proposal: await h.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } }), leases: await h.prisma.itemReservation.findMany({ where: { proposalId: proposal.id }, orderBy: { itemId: 'asc' } }), audits: await h.prisma.auditLog.count({ where: { entityId: proposal.id } }), commands: await h.prisma.idempotencyRecord.findMany({ where: { key } }) });
  const before = await state();
  let reached!: () => void; let release!: () => void;
  const frozen = new Promise<void>(resolve => { reached = resolve; }); const resume = new Promise<void>(resolve => { release = resolve; });
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const row = await original(tx, entry); if (entry.action === 'TRADING_FROZEN') { reached(); await resume; } return row; });
  const freezing = desktop.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '重放期间冻结' });
  await frozen;
  const replaying = h.command(h.actors.recipient, path, input, key).then(r => r);
  let waiting: boolean; try { waiting = await observeRestrictionWait(); } finally { release(); }
  expect((await freezing).status).toBe(200);
  expect(await replaying).toMatchObject({ status: 200, body: saved });
  expect(waiting).toBe(true); expect(await state()).toEqual(before);
});
it.each(['DRAFT', 'REJECTED', 'INACTIVE', 'PENDING_REVIEW'] as const)('does not reveal a %s target even to an independently frozen caller', async status => {
  const offered = await activeItem(h, h.actors.initiator.id); const target = await activeItem(h);
  await h.prisma.item.update({ where: { id: target.id }, data: { status } });
  expect((await desktop.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '调用方自身限制' })).status).toBe(200);
  const before = await tradingSnapshot();
  await h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: [offered.id], targetItemId: target.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(409).expect(r => expect(r.body.code).toBe('ITEM_UNAVAILABLE'));
  expect(await tradingSnapshot()).toEqual(before);
});
it.each(['hidden', 'frozen'] as const)('rechecks proposal target privacy when it becomes %s while restriction acquisition waits', async change => {
  const offered = await activeItem(h, h.actors.initiator.id); const target = await activeItem(h);
  let reached!: () => void; let release!: () => void;
  const held = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const before = { proposals: await h.prisma.proposal.count(), audits: await h.prisma.auditLog.count(), keys: await h.prisma.idempotencyRecord.count() };
  const holding = h.prisma.$transaction(async tx => {
    await h.app.get(TradingRestrictionsService).lock(tx, [target.ownerId]);
    reached(); await resume;
    if (change === 'hidden') await tx.item.update({ where: { id: target.id }, data: { status: 'DRAFT' } });
    else await tx.tradingRestriction.update({ where: { userId: target.ownerId }, data: { status: 'FROZEN', reason: '并发风险夹具' } });
  });
  await held;
  const creating = h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: [offered.id], targetItemId: target.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).then(r => r);
  let waiting: boolean;
  try { waiting = await observeRestrictionWait(); } finally { release(); }
  await holding;
  const response = await creating;
  expect(waiting).toBe(true);
  expect(response).toMatchObject({ status: 409, body: { code: 'ITEM_UNAVAILABLE' } });
  expect({ proposals: await h.prisma.proposal.count(), audits: await h.prisma.auditLog.count(), keys: await h.prisma.idempotencyRecord.count() }).toEqual(before);
});
it.each([
  ['DRAFT', false], ['DRAFT', true], ['REJECTED', false], ['REJECTED', true],
  ['INACTIVE', false], ['INACTIVE', true], ['PENDING_REVIEW', false], ['PENDING_REVIEW', true],
  ['ACTIVE', true], ['ABSENT', false], ['ABSENT', true],
] as const)('keeps proposal target privacy for %s with owner frozen=%s', async (status, frozen) => {
  const offered = await activeItem(h, h.actors.initiator.id);
  const target = status === 'ABSENT' ? { id: randomUUID() } : await activeItem(h);
  if (status !== 'ABSENT' && status !== 'ACTIVE') await h.prisma.item.update({ where: { id: target.id }, data: { status } });
  if (frozen) expect((await desktop.action(`/api/admin/risk/users/${h.actors.recipient.id}/freeze`, 'FREEZE_TRADING', h.actors.recipient.id, { expectedVersion: 1, reason: '不得向非参与人披露' })).status).toBe(200);
  const before = await tradingSnapshot();
  await h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: [offered.id], targetItemId: target.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(409).expect(r => expect(r.body).toMatchObject({ code: 'ITEM_UNAVAILABLE', message: 'A proposal item is unavailable or not owned by the required participant' }));
  expect(await tradingSnapshot()).toEqual(before);
});
