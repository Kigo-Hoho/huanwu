import { test, expect } from '@playwright/test';
import { api, app, command, prepareConfirmedExchange, createOrder, prepareAddresses, fundOrder, refresh, visibleText } from './support/orders';

test('both customers cancel before handover, receive full refunds and original items become publicly available', async ({ browser, request, page: visitor }) => {
  const exchange = await prepareConfirmedExchange({ browser, request, differenceFen: 1200, payer: 'RECIPIENT' });
  try {
    const id = await createOrder(exchange); await prepareAddresses(exchange, id); await fundOrder(exchange, id, 'RECIPIENT');
    await exchange.initiator.getByLabel('操作原因', { exact: true }).locator('input').fill('双方决定在交接前取消');
    await command(exchange.initiator, '申请取消订单', `/orders/${id}/cancellation`); await refresh(exchange.recipient);
    await expect(exchange.recipient.getByRole('button', { name: '登记我的运单', exact: true })).toHaveCount(0);
    await command(exchange.recipient, '同意取消订单', `/orders/${id}/cancellation/respond`);
    for (const page of [exchange.initiator, exchange.recipient]) { await expect.poll(async () => (await refresh(page)).status).toBe('CANCELLED'); await expect(visibleText(page, '已取消')).toBeVisible(); }
    const cancelled = await refresh(exchange.initiator); expect(cancelled.parties.flatMap(party => party.payments).map(payment => payment.status)).toEqual(['REFUNDED', 'REFUNDED', 'REFUNDED']);
    expect(cancelled.parties.flatMap(party => party.payments).map(payment => payment.amountFen).sort((a, b) => a - b)).toEqual([1000, 1000, 1200]);
    for (const item of exchange.items) {
      const publicItem = await request.get(`${api}/items/${item.id}`); expect(publicItem.status()).toBe(200); expect((await publicItem.json()).availableForProposal).toBe(true);
      await visitor.goto(`${app}/pages/items/public-detail/index?id=${item.id}`); await expect(visibleText(visitor, '可投物')).toBeVisible(); await expect(visitor.getByRole('button', { name: '我要换', exact: true })).toBeEnabled();
    }
  } finally { await exchange.dispose(); }
});
