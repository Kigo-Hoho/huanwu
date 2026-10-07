import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { ItemView, OrderView } from '@barter/contracts';
import pg from 'pg';

export const api = 'http://127.0.0.1:3000/api';
export const app = 'http://127.0.0.1:10086/#';
type Session = { accessToken: string; user: { id: string } };
export const visibleText = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true });

// Only external-provider readiness and final immutable outcome evidence use SQL.
// The connection itself is read-only; every business action remains a page click.
async function readOwned(sql: string, values: unknown[]) {
  let url: string;
  try {
    url = JSON.parse(process.env.BARTER_E2E_API_ENV ?? '{}').DATABASE_URL;
    const name = new URL(url).pathname.slice(1);
    if (!/^barter_p3_[a-f0-9]{16}_[a-f0-9]{12}$/.test(name) || name !== process.env.BARTER_E2E_DATABASE_NAME || !process.env.BARTER_E2E_SOURCE_DATABASE_NAME || name === process.env.BARTER_E2E_SOURCE_DATABASE_NAME || !/^SELECT\s/.test(sql) || sql.includes(';')) throw new Error();
  } catch { throw new Error('Read-only acceptance evidence requires the current owned database'); }
  const client = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  try { await client.connect(); return (await client.query(sql, values)).rows; }
  catch { throw new Error('Read-only acceptance evidence query failed'); }
  finally { await client.end(); }
}

async function login(page: Page, code: string): Promise<Session> {
  await page.addInitScript(identityCode => Object.assign(globalThis, { __BARTER_ACCEPTANCE_IDENTITY_CODE__: identityCode }), code);
  const response = page.waitForResponse(value => value.url() === `${api}/auth/wechat` && value.request().method() === 'POST');
  await page.goto(`${app}/pages/items/mine/index`);
  const authenticated = await response; expect(authenticated.status()).toBe(201);
  await expect(page.getByRole('button', { name: '我的订单', exact: true })).toBeVisible();
  return authenticated.json();
}

async function reviewedItems(request: APIRequestContext, session: Session, reviewer: string, count: number) {
  const headers = { Authorization: `Bearer ${session.accessToken}` }; const imageUrls: string[] = [];
  for (const n of [1, 2, 3]) {
    const uploaded = await request.post(`${api}/uploads/item-images`, { headers, multipart: { file: { name: `item-${n}.jpg`, mimeType: 'image/jpeg', buffer: await readFile(`e2e/fixtures/item-${n}.jpg`) } } });
    expect(uploaded.status()).toBe(201); imageUrls.push((await uploaded.json()).url);
  }
  const items: ItemView[] = [];
  for (let n = 0; n < count; n++) {
    const created = await request.post(`${api}/items`, { headers, data: { title: `履约验收 ${randomUUID()}`, description: '真实上传审核的双用户履约物品', condition: 'GOOD', referenceValueFen: 12000, wantedText: '交换闲置', imageUrls } });
    expect(created.status()).toBe(201); const item = await created.json();
    const submitted = await request.post(`${api}/items/${item.id}/submit`, { headers: { ...headers, 'Idempotency-Key': randomUUID() } }); expect(submitted.status()).toBe(200);
    const reviewed = await request.post(`${api}/admin/items/${item.id}/reviews`, { headers: { Authorization: `Bearer ${reviewer}` }, data: { decision: 'APPROVE', expectedVersion: (await submitted.json()).version } });
    expect(reviewed.status()).toBe(200); const active = await reviewed.json(); expect(active.status).toBe('ACTIVE'); expect(active.ownerId).toBe(session.user.id); items.push(active);
  }
  return items;
}

// HTTP preparation ends at the confirmed proposal. Every order action below uses its page.
export async function prepareConfirmedExchange({ browser, request, mode = 'COURIER', offeredCount = 1, differenceFen = 0, payer = 'NONE' }: {
  browser: Browser; request: APIRequestContext; mode?: 'COURIER' | 'IN_PERSON'; offeredCount?: number; differenceFen?: number; payer?: 'NONE' | 'INITIATOR' | 'RECIPIENT';
}) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const initiator = await contexts[0].newPage(); const recipient = await contexts[1].newPage();
    const first = await login(initiator, 'e2e-customer-code'); const second = await login(recipient, 'e2e-customer-two-code');
    expect(first.user.id !== second.user.id).toBe(true); expect(first.accessToken !== second.accessToken).toBe(true);
    for (const [page, own, other] of [[initiator, first, second], [recipient, second, first]] as const) {
      const storage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
      expect(storage.includes(own.accessToken)).toBe(true); expect(storage.includes(other.accessToken)).toBe(false);
      const actor = await request.get(`${api}/me`, { headers: { Authorization: `Bearer ${own.accessToken}` } }); expect(actor.status()).toBe(200); expect((await actor.json()).id).toBe(own.user.id);
    }
    const admin = await request.post(`${api}/auth/admin/password`, { data: { email: 'reviewer@barter.local', password: process.env.E2E_REVIEWER_PASSWORD } }); expect(admin.status()).toBe(201);
    const reviewer = (await admin.json()).accessToken;
    const offered = await reviewedItems(request, first, reviewer, offeredCount); const [target] = await reviewedItems(request, second, reviewer, 1);
    const proposed = await request.post(`${api}/proposals`, { headers: { Authorization: `Bearer ${first.accessToken}`, 'Idempotency-Key': randomUUID() }, data: { offeredItemIds: offered.map(item => item.id), targetItemId: target.id, differenceFen, payer, deliveryMode: mode, initiatorShippingFen: 0, recipientShippingFen: 0 } });
    expect(proposed.status()).toBe(201); const proposal = await proposed.json();
    const accepted = await request.post(`${api}/proposals/${proposal.id}/accept`, { headers: { Authorization: `Bearer ${second.accessToken}`, 'Idempotency-Key': randomUUID() }, data: { expectedVersion: proposal.version } }); expect(accepted.status()).toBe(200); expect((await accepted.json()).status).toBe('CONFIRMED');
    return { initiator, recipient, first, second, proposalId: proposal.id as string, items: [...offered, target], request, dispose: async () => { await Promise.all(contexts.map(context => context.close())); } };
  } catch (error) { await Promise.all(contexts.map(context => context.close())); throw error; }
}
export type Exchange = Awaited<ReturnType<typeof prepareConfirmedExchange>>;

export async function command(page: Page, name: string, path: string): Promise<OrderView> {
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  const pending = page.waitForResponse(value => value.url() === `${api}${path}` && value.request().method() === 'POST');
  await page.getByRole('button', { name, exact: true }).click();
  const response = await pending; expect(response.ok(), `${name} HTTP ${response.status()}`).toBe(true);
  expect(Boolean(response.request().headers()['idempotency-key'])).toBe(true);
  const result = await response.json();
  return result.order;
}

export async function createOrder(exchange: Exchange) {
  await exchange.initiator.goto(`${app}/pages/proposals/detail/index?id=${exchange.proposalId}`);
  const order = await command(exchange.initiator, '生成交换订单', `/proposals/${exchange.proposalId}/order`);
  await exchange.initiator.getByRole('button', { name: '查看交换订单', exact: true }).click();
  await exchange.recipient.goto(`${app}/pages/orders/detail/index?id=${order.id}`);
  for (const page of [exchange.initiator, exchange.recipient]) await expect(visibleText(page, '测试支付／测试物流，不产生真实资金或寄递')).toBeVisible();
  expect(order.initiatorId).toBe(exchange.first.user.id); expect(order.recipientId).toBe(exchange.second.user.id);
  return order.id;
}

export async function refresh(page: Page) {
  const response = page.waitForResponse(value => /\/api\/orders\/[^/]+$/.test(value.url()) && value.request().method() === 'GET');
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  const result = await response; expect(result.status()).toBe(200);
  await expect(page.getByRole('button', { name: '刷新订单', exact: true })).toBeEnabled();
  const order: OrderView = await result.json();
  await expect(visibleText(page, `订单版本：${order.version}`)).toBeVisible();
  return order;
}

export async function prepareAddresses(exchange: Exchange, id: string) {
  for (const [index, page] of [exchange.initiator, exchange.recipient].entries()) {
    await refresh(page);
    for (const [label, value] of [['收件人', `验收${index}`], ['电话', `1381111222${index}`], ['地区', '测试市'], ['详细地址', `测试街道${index}号`]]) await page.getByLabel(label, { exact: true }).locator('input').fill(value);
    await command(page, '保存我的收货资料', `/orders/${id}/address`);
  }
}

export async function fundOrder(exchange: Exchange, id: string, differencePayer?: 'INITIATOR' | 'RECIPIENT') {
  for (const [side, page] of [['INITIATOR', exchange.initiator], ['RECIPIENT', exchange.recipient]] as const) {
    for (const label of differencePayer === side ? ['保证金', '差价'] : ['保证金']) {
      await refresh(page);
      const created = await command(page, `发起${label}付款`, `/orders/${id}/payments`);
      const intent = created.parties.find(party => party.side === side)!.payments.find(payment => payment.purpose === (label === '保证金' ? 'DEPOSIT' : 'DIFFERENCE'))!;
      await expect.poll(async () => (await refresh(page)).parties.find(party => party.side === side)!.payments.find(payment => payment.id === intent.id)?.status).toBe('PENDING');
      await command(page, `完成测试${label}付款`, `/testing/payments/${intent.id}/complete`);
    }
  }
  for (const page of [exchange.initiator, exchange.recipient]) { await refresh(page); await expect(visibleText(page, '待双方履约')).toBeVisible(); }
  const funded = await refresh(exchange.initiator);
  expect(funded.parties.flatMap(party => party.payments).filter(payment => payment.purpose === 'DEPOSIT').map(payment => [payment.amountFen, payment.status])).toEqual([[1000, 'PAID'], [1000, 'PAID']]);
  if (differencePayer) expect(funded.parties.find(party => party.side === differencePayer)!.payments.find(payment => payment.purpose === 'DIFFERENCE')).toMatchObject({ amountFen: 1200, status: 'PAID' });
}

export async function courierHandover(exchange: Exchange, id: string) {
  const tracking = [];
  for (const [side, page] of [['INITIATOR', exchange.initiator], ['RECIPIENT', exchange.recipient]] as const) {
    await refresh(page); const number = `E2E${randomUUID().replaceAll('-', '').toUpperCase()}${'9'.repeat(25)}`; tracking.push(number);
    await page.getByLabel('承运人', { exact: true }).locator('input').fill('验收快递'); await page.getByLabel('运单号', { exact: true }).locator('input').fill(number);
    const registered = await command(page, '登记我的运单', `/orders/${id}/shipments`);
    const shipment = registered.parties.find(party => party.side === side)!.outgoingShipment!;
    await expect.poll(async () => (await readOwned('SELECT status FROM "SimulatedProviderOperation" WHERE "businessNo"=$1 AND kind=\'VERIFY_SHIPMENT\' AND payload->>\'shipmentId\'=$2', [`shipment:${shipment.id}`, shipment.id]))[0]?.status).toBe('PENDING');
    await refresh(page); // External registration admission legitimately advances revision.
    await command(page, '测试我的去件已揽收', `/testing/shipments/${shipment.id}/progress`);
  }
  for (const page of [exchange.initiator, exchange.recipient]) {
    const current = await refresh(page); expect(current.status).toBe('IN_TRANSIT'); expect(current.parties.every(party => party.outgoingShipment?.status === 'COLLECTED')).toBe(true);
    await expect(visibleText(page, '运输中')).toBeVisible();
  }
  for (const [side, page] of [['INITIATOR', exchange.initiator], ['RECIPIENT', exchange.recipient]] as const) {
    const current = await refresh(page); const shipment = current.parties.find(party => party.side === side)!.outgoingShipment!;
    await command(page, '测试我的去件已送达', `/testing/shipments/${shipment.id}/progress`);
  }
  return tracking;
}

export async function completeOrder(exchange: Exchange, id: string) {
  for (const page of [exchange.initiator, exchange.recipient]) {
    const current = await refresh(page); expect(current.parties.every(party => Boolean(party.incomingDeliveredAt))).toBe(true);
    await command(page, '验收我的来件', `/orders/${id}/acceptance`);
  }
  for (const page of [exchange.initiator, exchange.recipient]) {
    await expect.poll(async () => (await refresh(page)).status).toBe('COMPLETED'); await expect(visibleText(page, '已完成')).toBeVisible();
  }
  const complete = await refresh(exchange.initiator);
  expect(complete.parties.every(party => Boolean(party.acceptedAt))).toBe(true);
  expect(complete.parties.flatMap(party => party.payments).filter(payment => payment.purpose === 'DEPOSIT').map(payment => payment.status)).toEqual(['REFUNDED', 'REFUNDED']);
  for (const item of exchange.items) {
    expect((await exchange.request.get(`${api}/items/${item.id}`)).status()).toBe(404);
    const session = item.ownerId === exchange.first.user.id ? exchange.first : exchange.second;
    const original = await exchange.request.get(`${api}/me/items/${item.id}`, { headers: { Authorization: `Bearer ${session.accessToken}` } }); expect(original.status()).toBe(200); expect(await original.json()).toMatchObject({ status: 'UNPUBLISHED', ownerId: item.ownerId });
    const persisted = await readOwned('SELECT status, "ownerId", version FROM "Item" WHERE id=$1::uuid', [item.id]);
    expect(persisted).toEqual([{ status: 'INACTIVE', ownerId: item.ownerId, version: item.version + 1 }]);
  }
}
