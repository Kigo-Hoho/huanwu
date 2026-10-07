import { test, expect } from '@playwright/test';
import { prepareConfirmedExchange, createOrder, prepareAddresses, fundOrder, courierHandover, completeOrder } from './support/orders';

test('isolated customers complete courier five-for-one, difference and both deposits; original six stay inactive', async ({ browser, request }) => {
  const exchange = await prepareConfirmedExchange({ browser, request, offeredCount: 5, differenceFen: 1200, payer: 'INITIATOR' });
  try {
    expect(exchange.items).toHaveLength(6);
    const id = await createOrder(exchange); await prepareAddresses(exchange, id); await fundOrder(exchange, id, 'INITIATOR');
    await courierHandover(exchange, id); await completeOrder(exchange, id);
  } finally { await exchange.dispose(); }
});
