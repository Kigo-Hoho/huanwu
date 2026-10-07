import { test, expect, type Page } from '@playwright/test';
import { prepareConfirmedExchange, createOrder, prepareAddresses, fundOrder, courierHandover } from './support/orders';

async function fits(page: Page) {
  const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, main: document.querySelector('main')!.scrollWidth, mainClient: document.querySelector('main')!.clientWidth, width: innerWidth }));
  expect(dimensions.width).toBe(390); expect(dimensions.document).toBeLessThanOrEqual(390); expect(dimensions.main).toBeLessThanOrEqual(dimensions.mainClient);
}

test('390px operations order query shows both funds and logistics, long identifiers wrap, and actions stay read-only', async ({ browser, request, page: operator }) => {
  const exchange = await prepareConfirmedExchange({ browser, request, differenceFen: 1200, payer: 'INITIATOR' });
  try {
    const id = await createOrder(exchange); await prepareAddresses(exchange, id); await fundOrder(exchange, id, 'INITIATOR'); const tracking = await courierHandover(exchange, id);
    await operator.setViewportSize({ width: 390, height: 844 }); await operator.goto('http://127.0.0.1:5173/login');
    await operator.getByLabel('邮箱').fill('operations@barter.local'); await operator.getByLabel('密码').fill(process.env.E2E_REVIEWER_PASSWORD!); await operator.getByRole('button', { name: '登录', exact: true }).click();
    await operator.getByRole('link', { name: '订单查询', exact: true }).click(); await fits(operator);
    await operator.getByRole('link', { name: `查看订单 ${id}`, exact: true }).click();
    await expect(operator.getByText('仅供查询，运营不能代替用户履约或处理资金', { exact: true })).toBeVisible();
    for (const side of ['发起方', '接收方']) await expect(operator.getByText(`${side}进度`, { exact: true })).toBeVisible();
    await expect(operator.getByText('PAID · ¥10.00', { exact: true })).toHaveCount(2); await expect(operator.getByText('PAID · ¥12.00', { exact: true })).toBeVisible();
    for (const number of tracking) await expect(operator.getByText(`验收快递 · ${number}`, { exact: true })).toBeVisible();
    await expect(operator.getByText('已确认签收', { exact: true })).toHaveCount(2);
    await expect(operator.getByRole('button', { name: /验收|交出|登记.*运单|付款|取消订单|退款|处理资金/ })).toHaveCount(0); await fits(operator);
    await test.info().attach('390px-readonly-order', { body: await operator.screenshot({ fullPage: true }), contentType: 'image/png' });
  } finally { await exchange.dispose(); }
});
