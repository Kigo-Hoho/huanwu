import { afterAll, beforeAll, expect, it } from 'vitest';
import { createCompensationHarness, type CompensationHarness } from './support/compensation-harness.js';
import { CaseFinalizationService } from '../../src/after-sales/case-finalization.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { vi } from 'vitest';
let h: CompensationHarness;
beforeAll(async () => { h = await createCompensationHarness(); });
afterAll(async () => { await h?.close(); });
it('preserves historical completion and reservations now belonging to a later order', async () => {
  const historical = await h.prepareOrder({ mode: 'IN_PERSON' });
  await h.prisma.order.update({ where: { id: historical.id }, data: { status: 'COMPLETED', completedAt: h.clock.now() } });
  const items = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: historical.id } });
  await h.prisma.itemReservation.deleteMany({ where: { orderId: historical.id } });
  const later = await h.prepareOrder({ mode: 'IN_PERSON' });
  // Historical fixture: the old item ids are now legitimately owned by a later
  // reservation namespace. Closure must never update or release by item id.
  for (const item of items) await h.prisma.itemReservation.create({ data: { itemId: item.itemId, orderId: later.id } });
  const f = await h.fixture({ historicalOrder: historical, type: 'RETURN_ORIGINALS', amount: 0, delivered: true }); await f.execute();
  await h.prisma.returnProgress.updateMany({ where: { obligation: { resolution: { caseId: f.caseId } } }, data: { status: 'CONFIRMED', confirmedAt: h.clock.now() } });
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(true);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: historical.id } })).status).toBe('COMPLETED');
  for (const item of items) expect((await h.prisma.itemReservation.findUniqueOrThrow({ where: { itemId: item.itemId } })).orderId).toBe(later.id);
});
it('safely cancels an undelivered exchange and releases only its reservations', async () => {
  const f = await h.fixture({ type: 'CANCEL_BEFORE_HANDOVER', amount: 0 });
  const other = await h.prepareOrder({ mode: 'IN_PERSON' });
  await f.execute();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('CANCELLED');
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('RESOLVED');
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: other.id } })).toBe(2);
});
it('retains all six reservations until all returns and funds are complete; audit failure rolls back the entire release', async () => {
  const f = await h.fixture({ type: 'RETURN_ORIGINALS', count: 5, delivered: true, amount: 500 });
  await f.execute();
  const returns = await h.prisma.returnObligation.findMany({ where: { resolution: { caseId: f.caseId } } });
  expect(returns).toHaveLength(6);
  expect(await h.prisma.compensationObligation.count({ where: { resolution: { caseId: f.caseId } } })).toBe(1);
  await h.prisma.returnProgress.updateMany({ where: { obligationId: { in: returns.slice(0, 5).map(r => r.id) } }, data: { status: 'CONFIRMED', confirmedAt: h.clock.now() } });
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(6);
  await h.prisma.returnProgress.update({ where: { obligationId: returns[5]!.id }, data: { status: 'CONFIRMED', confirmedAt: h.clock.now() } });
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
});
it('rolls back finalization and all reservation release when audit fails', async () => {
  const f = await h.fixture({ type: 'CANCEL_BEFORE_HANDOVER', amount: 0 });
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  const spy = vi.spyOn(audit, 'record').mockImplementation((tx, entry) => entry.action === 'CASE_RESOLVED' ? Promise.reject(new Error('finalization audit unavailable')) : original(tx, entry));
  try { await f.execute(500); } finally { spy.mockRestore(); }
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(2);
});
it('does not release reservations while an independent risk remains active', async () => {
  const f = await h.fixture({ type: 'RETURN_ORIGINALS', delivered: true, amount: 0 }); await f.execute();
  await h.prisma.returnProgress.updateMany({ where: { obligation: { resolution: { caseId: f.caseId } } }, data: { status: 'CONFIRMED', confirmedAt: h.clock.now() } });
  const risk = await h.prisma.riskTask.create({ data: { sourceKey: `task10:${f.caseId}`, kind: 'RETURN_DISPUTED', orderId: f.order.id, caseId: f.caseId, description: 'Independent unresolved risk' } });
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(2);
  await h.prisma.riskTask.update({ where: { id: risk.id }, data: { status: 'RESOLVED' } });
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(true);
});
it('finalizes six independently confirmed returns only on the last owner confirmation', async () => {
  const f = await h.fixture({ type: 'RETURN_ORIGINALS', count: 5, delivered: true, amount: 0 }); await f.execute();
  const obligations = () => h.prisma.returnObligation.findMany({ where: { resolution: { caseId: f.caseId } }, include: { progress: true }, orderBy: { id: 'asc' } });
  for (const side of ['INITIATOR', 'RECIPIENT'] as const) {
    const selected = (await obligations()).filter(o => o.holderSide === side);
    await h.command(side === 'INITIATOR' ? h.actors.initiator : h.actors.recipient, `/api/after-sales/${f.caseId}/returns/handover`, { ...await f.current(), obligationIds: selected.map(o => o.id), obligationVersions: selected.map(o => ({ obligationId: o.id, expectedVersion: o.progress!.version })) }).expect(200);
  }
  const all = await obligations();
  for (const [index, o] of all.entries()) {
    await h.command(o.ownerSide === 'INITIATOR' ? h.actors.initiator : h.actors.recipient, `/api/after-sales/${f.caseId}/returns/confirmation`, { ...await f.current(), obligationId: o.id, expectedObligationVersion: o.progress!.version, decision: 'CONFIRM' }).expect(200);
    expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(index === 5 ? 0 : 6);
  }
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('CANCELLED');
});
it('requires each participant independently to confirm receipt and retention, not agreement', async () => {
  const f = await h.fixture({ type: 'KEEP_WITH_COMPENSATION', amount: 0 });
  await f.execute();
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/keep-confirmation`, await f.current()).expect(409);
  await h.prisma.orderPartyProgress.updateMany({ where: { orderId: f.order.id }, data: { incomingDeliveredAt: h.clock.now(), handedOverAt: h.clock.now() } });
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/keep-confirmation`, await f.current()).expect(200);
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
  expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: f.order.id, side: 'RECIPIENT' } } })).acceptedAt).toBeNull();
  await h.command(h.actors.recipient, `/api/after-sales/${f.caseId}/keep-confirmation`, await f.current()).expect(200);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('COMPLETED');
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
});
