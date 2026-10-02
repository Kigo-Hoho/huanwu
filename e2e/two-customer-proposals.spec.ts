import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ItemView, ProposalView } from '@barter/contracts';

const api = 'http://127.0.0.1:3000/api';
const miniapp = 'http://127.0.0.1:10086/#';

async function loginCustomer(page: Page, code: string) {
  // Inject only the identity-code input. The application exchanges it and stores its own session.
  await page.addInitScript((identityCode) => {
    Object.assign(globalThis, { __BARTER_ACCEPTANCE_IDENTITY_CODE__: identityCode });
  }, code);
  await page.goto(`${miniapp}/pages/items/create/index`);
  const myItems = page.getByRole('button', { name: '我的物品', exact: true });
  await expect(myItems).toBeVisible();
  const login = page.waitForResponse(response => response.url() === `${api}/auth/wechat` && response.request().method() === 'POST', { timeout: 10_000 });
  await myItems.click();
  const response = await login;
  expect(response.status()).toBe(201);
  const session = await response.json();
  await expect(page.getByRole('button', { name: '投物箱', exact: true })).toBeVisible();
  return session as { accessToken: string; user: { id: string } };
}

async function reviewedItems(request: APIRequestContext, token: string, reviewer: string, titles: string[]) {
  const headers = { Authorization: `Bearer ${token}` };
  const imageUrls: string[] = [];
  for (const number of [1, 2, 3]) {
    const upload = await request.post(`${api}/uploads/item-images`, {
      headers,
      multipart: { file: { name: `item-${number}.jpg`, mimeType: 'image/jpeg', buffer: await readFile(`e2e/fixtures/item-${number}.jpg`) } },
    });
    expect(upload.ok()).toBeTruthy();
    imageUrls.push((await upload.json()).url);
  }
  const items: ItemView[] = [];
  for (const title of titles) {
    const created = await request.post(`${api}/items`, { headers, data: {
      title, description: '真实上传图片和审核的双用户交换验收物品', condition: 'GOOD', referenceValueFen: 12000, wantedText: '交换闲置', imageUrls,
    } });
    expect(created.status()).toBe(201);
    const item = await created.json();
    const submitted = await request.post(`${api}/items/${item.id}/submit`, {
      headers: { ...headers, 'Idempotency-Key': `submit-${item.id}` },
    });
    expect(submitted.status()).toBe(200);
    const pending = await submitted.json();
    const reviewed = await request.post(`${api}/admin/items/${item.id}/reviews`, {
      headers: { Authorization: `Bearer ${reviewer}` }, data: { decision: 'APPROVE', expectedVersion: pending.version },
    });
    expect(reviewed.status()).toBe(200);
    const active = await reviewed.json();
    expect(active.status).toBe('ACTIVE');
    items.push(active);
  }
  return items;
}

async function submitCommand(page: Page, name: string, path: string): Promise<ProposalView> {
  const response = page.waitForResponse(result => result.url() === `${api}${path}` && result.request().method() === 'POST');
  await page.getByRole('button', { name, exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  expect(result.request().headers()['idempotency-key']).toBeTruthy();
  return result.json();
}

test('two customers discover, counter with a replacement, reserve every item and cancel to release', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const initiatorContext = await browser.newContext();
  const recipientContext = await browser.newContext();
  const publicContext = await browser.newContext();
  try {
    const initiator = await initiatorContext.newPage();
    const recipient = await recipientContext.newPage();
    const visitor = await publicContext.newPage();
    const first = await loginCustomer(initiator, 'e2e-customer-code');
    const second = await loginCustomer(recipient, 'e2e-customer-two-code');
    expect(second.user.id, 'the two browser sessions must authenticate as different customers').not.toBe(first.user.id);

    const password = process.env.E2E_REVIEWER_PASSWORD;
    if (!password) throw new Error('E2E_REVIEWER_PASSWORD is required');
    const login = await request.post(`${api}/auth/admin/password`, { data: { email: 'reviewer@barter.local', password } });
    expect(login.ok()).toBeTruthy();
    const reviewer = (await login.json()).accessToken;
    const run = Date.now();
    const offered = await reviewedItems(request, first.accessToken, reviewer,
      ['书籍', '台灯', '耳机', '键盘', '手办'].map(name => `双用户${name} ${run}`));
    const [original, replacement] = await reviewedItems(request, second.accessToken, reviewer, [`双用户背包 ${run}`, `双用户替换相机 ${run}`]);
    expect(offered.every(item => item.ownerId === first.user.id)).toBe(true);
    expect([original, replacement].every(item => item.ownerId === second.user.id)).toBe(true);

    // Anonymous discovery uses the same public pages as the authenticated initiator.
    await visitor.goto(`${miniapp}/pages/items/discover/index`);
    await visitor.getByRole('button', { name: `查看 ${original.title}`, exact: true }).click();
    await expect(visitor.getByRole('button', { name: '我要换', exact: true })).toBeVisible();
    await expect(visitor.getByText('可投物', { exact: true }).filter({ visible: true })).toBeVisible();
    await initiator.getByRole('button', { name: '找换', exact: true }).click();
    await initiator.getByRole('button', { name: `查看 ${original.title}`, exact: true }).click();
    await initiator.getByRole('button', { name: '我要换', exact: true }).click();
    for (const item of offered) await initiator.getByRole('button', { name: `选择 ${item.title}`, exact: true }).click();
    await expect(initiator.getByRole('button', { name: `选择 ${replacement.title}`, exact: true })).toHaveCount(0);
    const created = await submitCommand(initiator, '提交方案', '/proposals');
    expect(created.initiatorId).toBe(first.user.id);
    expect(created.recipientId).toBe(second.user.id);
    expect(created.versions[0].offeredItems.map(item => item.itemId)).toEqual(offered.map(item => item.id));
    await expect(initiator.getByText('等待对方回应', { exact: true }).filter({ visible: true })).toBeVisible();

    await recipient.getByRole('button', { name: '投物箱', exact: true }).click();
    await recipient.getByRole('button', { name: '收到的投物', exact: true }).click();
    await recipient.getByRole('button', { name: `查看 ${original.title}`, exact: true }).click();
    await expect(recipient.getByText('轮到你回应', { exact: true }).filter({ visible: true })).toBeVisible();
    await recipient.getByRole('button', { name: '修改方案', exact: true }).click();
    await recipient.getByRole('button', { name: `选择 ${replacement.title}`, exact: true }).click();
    await recipient.getByLabel('差价（分）', { exact: true }).locator('input').fill('1200');
    await recipient.getByRole('button', { name: '接收方补差', exact: true }).click();
    await recipient.getByRole('button', { name: '选择快递', exact: true }).click();
    await expect(recipient.getByText('发起方运费（分）', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(recipient.getByText('接收方运费（分）', { exact: true }).filter({ visible: true })).toBeVisible();
    await recipient.getByLabel('发起方运费（分）', { exact: true }).locator('input').fill('600');
    await recipient.getByLabel('接收方运费（分）', { exact: true }).locator('input').fill('800');
    const countered = await submitCommand(recipient, '提交方案', `/proposals/${created.id}/counter`);
    expect(countered.currentVersion).toBe(2);
    expect(countered.versions[0]).toEqual(created.versions[0]);
    expect(countered.versions[1]).toMatchObject({ targetItem: { itemId: replacement.id }, differenceFen: 1200, payer: 'RECIPIENT', deliveryMode: 'COURIER', initiatorShippingFen: 600, recipientShippingFen: 800 });
    expect(countered.versions[1].offeredItems.map(item => item.itemId)).toEqual(offered.map(item => item.id));

    await initiator.getByRole('button', { name: '刷新方案', exact: true }).click();
    await expect(initiator.getByText('方案历史 · 第 2 版', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(initiator.getByText(`接收方：${replacement.title}`, { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(initiator.getByText('差价：￥12.00 · 接收方补差', { exact: true }).filter({ visible: true })).toBeVisible();
    const confirmed = await submitCommand(initiator, '接受方案', `/proposals/${created.id}/accept`);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.versions[1].offeredItems).toHaveLength(5);
    expect(Date.parse(confirmed.reservationExpiresAt!) - Date.parse(confirmed.confirmedAt!)).toBe(72 * 60 * 60 * 1000);
    await expect(initiator.getByText('已确认', { exact: true }).filter({ visible: true })).toBeVisible();
    for (const item of [...offered, replacement]) {
      await visitor.goto(`${miniapp}/pages/items/public-detail/index?id=${item.id}`);
      await expect(visitor.getByText(item.title, { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(visitor.getByText('暂不可投', { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(visitor.getByRole('button', { name: '我要换', exact: true })).toBeDisabled();
    }
    await visitor.goto(`${miniapp}/pages/items/public-detail/index?id=${original.id}`);
    await expect(visitor.getByText(original.title, { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(visitor.getByText('可投物', { exact: true }).filter({ visible: true })).toBeVisible();

    await recipient.getByRole('button', { name: '刷新方案', exact: true }).click();
    await expect(recipient.getByText('已确认', { exact: true }).filter({ visible: true })).toBeVisible();
    const cancelled = await submitCommand(recipient, '取消提案', `/proposals/${created.id}/cancel`);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.versions).toEqual(countered.versions);
    await expect(recipient.getByText('已取消', { exact: true }).filter({ visible: true })).toBeVisible();
    for (const item of [...offered, replacement]) {
      await visitor.goto(`${miniapp}/pages/items/public-detail/index?id=${item.id}`);
      await expect(visitor.getByText(item.title, { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(visitor.getByText('可投物', { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(visitor.getByRole('button', { name: '我要换', exact: true })).toBeEnabled();
    }
    await initiator.goto(`${miniapp}/pages/items/mine/index`);
    await initiator.getByRole('button', { name: '投物箱', exact: true }).click();
    await initiator.getByRole('button', { name: '发出的投物', exact: true }).click();
    await initiator.getByRole('button', { name: `查看 ${replacement.title}`, exact: true }).click();
    await expect(initiator.getByText('已取消', { exact: true }).filter({ visible: true })).toBeVisible();
  } finally {
    await initiatorContext.close();
    await recipientContext.close();
    await publicContext.close();
  }
});
