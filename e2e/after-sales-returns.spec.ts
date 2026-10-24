import { test, expect } from '@playwright/test';
import {
  prepareDeliveredCourier,
  prepareOperators,
  openAfterSalesCase,
  uploadEvidence,
  proposeReturnViaUi,
  consentBoth,
  saveReturnAddresses,
  dualApproveAndExecute,
  closeOriginalShipments,
  registerAndProgressReturns,
  assertThirdPartyEvidenceDenied,
  assertItemsNotRelisted,
  assertNoSecondPaymentCharge,
  readOwned,
  waitOutboxKinds,
  api,
} from './support/after-sales';

test.describe.configure({ mode: 'serial' });

test('two customers dispute, return originals with dual desktop approval, and items stay inactive', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const operators = await prepareOperators(browser);
  const prepared = await prepareDeliveredCourier(browser, request, 2);
  try {
    const { exchange, orderId } = prepared;
    const { caseId } = await openAfterSalesCase(exchange, orderId, 'e2e 双向退货争议');
    await uploadEvidence(exchange.initiator, '发起方实物证据');
    await uploadEvidence(exchange.recipient, '接收方实物证据');
    await proposeReturnViaUi(operators.ops, caseId);
    await consentBoth(exchange, caseId);
    await saveReturnAddresses(exchange, caseId);
    await dualApproveAndExecute(operators.admin1, operators.admin2, caseId);
    await waitOutboxKinds(orderId, ['REFUND_PAYMENT', 'CLOSE_PAYMENT']);
    await closeOriginalShipments(exchange, caseId, orderId);
    await registerAndProgressReturns(exchange, caseId, orderId);
    await expect.poll(async () => {
      const rows = await readOwned(`SELECT status FROM "AfterSalesCase" WHERE id=$1::uuid`, [caseId]);
      return rows[0]?.status;
    }, { timeout: 120_000 }).toBe('RESOLVED');
    for (const page of [exchange.initiator, exchange.recipient]) {
      await page.goto(`http://127.0.0.1:10086/#/pages/after-sales/detail/index?id=${caseId}`);
      await expect(page.getByText('已结案', { exact: true })).toBeVisible({ timeout: 30_000 });
    }
    const payments = await readOwned(
      `SELECT status FROM "PaymentIntent" WHERE "orderId"=$1::uuid`,
      [orderId],
    );
    expect(payments.every((row: { status: string }) => row.status === 'REFUNDED' || row.status === 'CLOSED')).toBe(true);
    await assertItemsNotRelisted(exchange);
    await assertNoSecondPaymentCharge(orderId);
    await assertThirdPartyEvidenceDenied(browser, caseId);
    const ownedName = process.env.BARTER_E2E_DATABASE_NAME;
    const sourceName = process.env.BARTER_E2E_SOURCE_DATABASE_NAME;
    expect(ownedName).toBeTruthy();
    expect(sourceName).toBeTruthy();
    expect(ownedName).not.toBe(sourceName);
  } finally {
    await prepared.exchange.dispose();
    await operators.dispose();
  }
});
