import { test, expect } from '@playwright/test';
import {
  prepareDeliveredCourier,
  prepareOperators,
  openAfterSalesCase,
  uploadEvidence,
  proposeKeepViaHttp,
  consentBoth,
  dualApproveAndExecute,
  confirmKeepBoth,
  payCompensation,
  assertThirdPartyEvidenceDenied,
  assertItemsNotRelisted,
  assertNoSecondPaymentCharge,
  readOwned,
  waitOutboxKinds,
} from './support/after-sales';

test.describe.configure({ mode: 'serial' });

test('keep with compensation collects simulated payment and closes the case', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const operators = await prepareOperators(browser);
  const prepared = await prepareDeliveredCourier(browser, request, 1);
  try {
    const { exchange, orderId } = prepared;
    const { caseId } = await openAfterSalesCase(exchange, orderId, 'e2e 保留并补偿争议');
    await uploadEvidence(exchange.initiator, '保留补偿证据');
    await proposeKeepViaHttp(operators.ops, caseId, 500);
    await consentBoth(exchange, caseId);
    await dualApproveAndExecute(operators.admin1, operators.admin2, caseId);
    await waitOutboxKinds(orderId, ['REFUND_PAYMENT', 'CLOSE_PAYMENT']);
    await confirmKeepBoth(exchange, caseId);
    await payCompensation(exchange, caseId);
    await expect.poll(async () => {
      const rows = await readOwned(`SELECT status FROM "AfterSalesCase" WHERE id=$1::uuid`, [caseId]);
      return rows[0]?.status;
    }, { timeout: 120_000 }).toBe('RESOLVED');
    await expect.poll(async () => {
      const rows = await readOwned(
        `SELECT cp.status FROM "CompensationPayment" cp
         JOIN "CompensationObligation" co ON co.id = cp."obligationId"
         JOIN "ResolutionVersion" rv ON rv.id = co."resolutionId"
         WHERE rv."caseId"=$1::uuid`,
        [caseId],
      );
      return rows.map((row: { status: string }) => row.status);
    }, { timeout: 90_000 }).toEqual(expect.arrayContaining(['PAID']));
    for (const page of [exchange.initiator, exchange.recipient]) {
      await page.goto(`http://127.0.0.1:10086/#/pages/after-sales/detail/index?id=${caseId}`);
      await expect(page.getByText('已结案', { exact: true })).toBeVisible({ timeout: 30_000 });
    }
    await assertItemsNotRelisted(exchange);
    await assertNoSecondPaymentCharge(orderId);
    await assertThirdPartyEvidenceDenied(browser, caseId);
  } finally {
    await prepared.exchange.dispose();
    await operators.dispose();
  }
});
