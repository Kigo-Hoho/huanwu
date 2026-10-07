import { test, expect } from '@playwright/test';
import { api, createOrder, prepareConfirmedExchange, refresh, command, visibleText } from './support/orders';

test('automatic reauthentication clears private order intent and requires the new participant confirmation', async ({ browser, request }) => {
  const exchange = await prepareConfirmedExchange({ browser, request });
  try {
    const id = await createOrder(exchange); const page = exchange.initiator;
    for (const [label, value] of [['收件人', '旧甲私有姓名'], ['电话', '13811112222'], ['地区', '测试地区'], ['详细地址', '旧甲私有地址']]) await page.getByLabel(label, { exact: true }).locator('input').fill(value);
    const addressRequests: string[] = [];
    page.on('request', r => { if (r.url() === `${api}/orders/${id}/address` && r.method() === 'POST') addressRequests.push(r.postData() ?? ''); });
    await page.evaluate(() => Object.assign(globalThis, { __BARTER_ACCEPTANCE_IDENTITY_CODE__: 'e2e-customer-two-code' }));
    // Only inject an authentication rejection; all auth and business successes use the owned real API.
    await page.route(`${api}/orders/${id}/address`, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }), { times: 1 });
    await page.getByRole('button', { name: '保存我的收货资料', exact: true }).click();
    await expect(visibleText(page, '登录身份已变化或无法核实，请刷新订单并重新确认操作。')).toBeVisible();
    await expect(page.getByLabel('收件人', { exact: true })).toHaveCount(0); expect(addressRequests).toHaveLength(1);
    const unchanged = await refresh(page); expect(unchanged.version).toBe(1); expect(unchanged.parties.every(p => !p.addressReady)).toBe(true);
    for (const label of ['收件人', '电话', '地区', '详细地址']) await expect(page.getByLabel(label, { exact: true }).locator('input')).toHaveValue('');
    for (const [label, value] of [['收件人', '乙重新确认'], ['电话', '13911112222'], ['地区', '乙地区'], ['详细地址', '乙重新填写地址']]) await page.getByLabel(label, { exact: true }).locator('input').fill(value);
    const saved = await command(page, '保存我的收货资料', `/orders/${id}/address`);
    expect(saved.parties.find(p => p.side === 'RECIPIENT')?.addressReady).toBe(true); expect(saved.parties.find(p => p.side === 'INITIATOR')?.addressReady).toBe(false);
    expect(addressRequests).toHaveLength(2); expect(JSON.parse(addressRequests[1]).recipientName).toBe('乙重新确认');
    await page.getByRole('button', { name: '查看我的收货资料', exact: true }).click(); await expect(page.getByText(/即时收货资料：乙重新确认/)).toBeVisible();
    await page.evaluate(() => Object.assign(globalThis, { __BARTER_ACCEPTANCE_IDENTITY_CODE__: 'e2e-customer-code' }));
    let reads = 0; page.on('request', r => { if (r.url().includes(`/orders/${id}/shipping-address`)) reads += 1; });
    await page.route(`${api}/orders/${id}/shipping-address?side=self`, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }), { times: 1 });
    await page.getByRole('button', { name: '查看我的收货资料', exact: true }).click();
    await expect(visibleText(page, '登录身份已变化或无法核实，请刷新订单并重新确认操作。')).toBeVisible();
    await expect(page.getByText(/即时收货资料：/)).toHaveCount(0); expect(reads).toBe(1);
  } finally { await exchange.dispose(); }
});
