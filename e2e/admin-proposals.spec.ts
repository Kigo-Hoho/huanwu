import { expect, test } from '@playwright/test';

test('operator proposal list and full history remain read-only and fit 390px', async ({ page, request }) => {
  const base = 'http://127.0.0.1:3000/api';
  const password = process.env.E2E_REVIEWER_PASSWORD;
  if (!password) throw new Error('E2E_REVIEWER_PASSWORD is required');
  const login = await request.post(`${base}/auth/admin/password`, { data: { email: 'reviewer@barter.local', password } });
  expect(login.ok()).toBeTruthy();
  const reviewer = (await login.json()).accessToken;
  const tokens: string[] = [];
  for (const code of ['e2e-customer-code', 'e2e-customer-two-code']) {
    const result = await request.post(`${base}/auth/wechat`, { data: { code } });
    expect(result.ok()).toBeTruthy(); tokens.push((await result.json()).accessToken);
  }
  const ids: string[] = [];
  const title = `手机查询测试 ${Date.now()}`;
  for (let side = 0; side < 2; side++) {
    const created = await request.post(`${base}/items`, { headers: { Authorization: `Bearer ${tokens[side]}` }, data: {
      title: `${title} ${side}`, description: '完整保留物品内容用于只读提案浏览器验收', condition: 'GOOD', referenceValueFen: 12000, wantedText: '换闲置', imageUrls: [1, 2, 3].map(i => `https://example.test/item-${i}.jpg`),
    } });
    expect(created.ok()).toBeTruthy();
    const item = await created.json(); ids.push(item.id);
    const submitted = await request.post(`${base}/items/${item.id}/submit`, { headers: { Authorization: `Bearer ${tokens[side]}`, 'Idempotency-Key': `submit-${item.id}` } });
    expect(submitted.ok()).toBeTruthy();
    const pending = await submitted.json();
    const reviewed = await request.post(`${base}/admin/items/${item.id}/reviews`, { headers: { Authorization: `Bearer ${reviewer}` }, data: { decision: 'APPROVE', expectedVersion: pending.version } });
    expect(reviewed.ok()).toBeTruthy();
  }
  const result = await request.post(`${base}/proposals`, { headers: { Authorization: `Bearer ${tokens[0]}`, 'Idempotency-Key': `proposal-${ids[0]}` }, data: { offeredItemIds: [ids[0]], targetItemId: ids[1], differenceFen: 100, payer: 'INITIATOR', deliveryMode: 'COURIER', initiatorShippingFen: 500, recipientShippingFen: 700 } });
  expect(result.ok()).toBeTruthy();
  const proposal = await result.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/login');
  await page.getByLabel('邮箱').fill('operations@barter.local');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('link', { name: '交换提案', exact: true }).click();
  await expect(page.getByRole('list', { name: '交换提案' })).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
  await page.getByRole('link', { name: `查看提案 ${proposal.id}` }).click();
  await expect(page.getByText('方案历史 · 第 1 版')).toBeVisible();
  await expect(page.getByRole('heading', { name: `发起方：${title} 0` })).toBeVisible();
  await expect(page.getByText('差价：¥1.00 · 发起方补差')).toBeVisible();
  await expect(page.getByText('仅供查询，运营不能代替用户协商')).toBeVisible();
  await expect(page.getByRole('button', { name: /接受方案|拒绝方案|取消提案|修改方案/ })).toHaveCount(0);
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
});
