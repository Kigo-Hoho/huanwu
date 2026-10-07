import { test, expect } from '@playwright/test';
import { command, prepareConfirmedExchange, createOrder, fundOrder, refresh, completeOrder } from './support/orders';

test('in-person order requires both handovers and acceptances with no shipping address or waybill', async ({ browser, request }) => {
  const exchange = await prepareConfirmedExchange({ browser, request, mode: 'IN_PERSON' });
  try {
    const id = await createOrder(exchange); await fundOrder(exchange, id);
    for (const page of [exchange.initiator, exchange.recipient]) {
      await refresh(page); await expect(page.getByLabel('详细地址', { exact: true })).toHaveCount(0); await expect(page.getByLabel('运单号', { exact: true })).toHaveCount(0);
      await command(page, '确认我已交出物品', `/orders/${id}/handover`);
    }
    const handedOver = await refresh(exchange.initiator); expect(handedOver.parties.every(party => Boolean(party.handedOverAt) && !party.outgoingShipment)).toBe(true);
    await completeOrder(exchange, id);
  } finally { await exchange.dispose(); }
});
