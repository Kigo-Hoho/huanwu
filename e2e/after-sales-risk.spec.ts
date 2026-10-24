import { test, expect } from '@playwright/test';
import {
  prepareOperators,
  prepareMobileReviewer,
  prepareDeliveredCourier,
  adminApp,
  readOwned,
  api,
} from './support/after-sales';

test.describe.configure({ mode: 'serial' });

test('mobile freeze works, mobile unfreeze is denied, desktop unfreeze restores trading', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const operators = await prepareOperators(browser);
  const reviewer = await prepareMobileReviewer(browser);
  const prepared = await prepareDeliveredCourier(browser, request, 1);
  try {
    const userId = prepared.exchange.first.user.id;
    await reviewer.page.setViewportSize({ width: 390, height: 844 });
    await reviewer.page.goto(`${adminApp}/risk/actions`);
    await expect(reviewer.page.getByRole('heading', { name: '单项处置' })).toBeVisible();
    await reviewer.page.getByLabel('用户 ID').fill(userId);
    await reviewer.page.getByRole('button', { name: '查询交易限制', exact: true }).click();
    await expect(reviewer.page.getByText(/限制状态 CLEAR/)).toBeVisible({ timeout: 15_000 });
    await reviewer.page.getByLabel('处置原因').fill('e2e 移动紧急冻结');
    await expect(reviewer.page.getByLabel('桌面恢复入口')).toHaveCount(0);
    await expect(reviewer.page.getByText(/解冻与风险解除需桌面受信会话/)).toBeVisible();
    await reviewer.page.getByRole('button', { name: '冻结交易', exact: true }).click();
    await expect(reviewer.page.getByLabel('管理员密码')).toBeVisible();
    await reviewer.page.getByLabel('管理员密码').fill(process.env.E2E_REVIEWER_PASSWORD!);
    const freezePending = reviewer.page.waitForResponse(
      (r) => r.url().includes(`/api/admin/risk/users/${userId}/freeze`) && r.request().method() === 'POST',
    );
    await reviewer.page.getByRole('button', { name: '重新验证并执行', exact: true }).click();
    expect((await freezePending).ok()).toBe(true);
    await expect(reviewer.page.getByText(/限制状态 FROZEN/)).toBeVisible({ timeout: 15_000 });

    const denied = await reviewer.page.request.post(`${adminApp}/api/admin/security/grants`, {
      headers: {
        Authorization: `Bearer ${reviewer.token}`,
        Origin: adminApp,
        'Idempotency-Key': `unfreeze-denied:${userId}`,
      },
      data: {
        action: 'UNFREEZE_TRADING',
        resourceId: userId,
        expectedVersions: { expectedVersion: 2 },
        requestHash: '0'.repeat(64),
        password: process.env.E2E_REVIEWER_PASSWORD,
      },
    });
    expect(denied.status()).toBe(403);
    const deniedBody = await denied.json();
    expect(deniedBody.code ?? deniedBody.message ?? JSON.stringify(deniedBody)).toMatch(/DESKTOP_SESSION_REQUIRED|desktop/i);

    await operators.admin1.page.setViewportSize({ width: 1280, height: 800 });
    await operators.admin1.page.goto(`${adminApp}/risk/actions`);
    await expect(operators.admin1.page.getByLabel('桌面恢复入口')).toBeVisible();
    await operators.admin1.page.getByLabel('用户 ID').fill(userId);
    await operators.admin1.page.getByRole('button', { name: '查询交易限制', exact: true }).click();
    await expect(operators.admin1.page.getByText(/限制状态 FROZEN/)).toBeVisible({ timeout: 15_000 });
    await operators.admin1.page.getByLabel('期望版本').fill('2');
    await operators.admin1.page.getByLabel('处置原因').fill('e2e 桌面解冻恢复');
    await operators.admin1.page.getByRole('button', { name: '解冻交易', exact: true }).click();
    await expect(operators.admin1.page.getByLabel('管理员密码')).toBeVisible();
    await operators.admin1.page.getByLabel('管理员密码').fill(process.env.E2E_REVIEWER_PASSWORD!);
    const unfreezePending = operators.admin1.page.waitForResponse(
      (r) => r.url().includes(`/api/admin/risk/users/${userId}/unfreeze`) && r.request().method() === 'POST',
    );
    await operators.admin1.page.getByRole('button', { name: '重新验证并执行', exact: true }).click();
    expect((await unfreezePending).ok()).toBe(true);
    await expect(operators.admin1.page.getByText(/限制状态 CLEAR/)).toBeVisible({ timeout: 15_000 });

    const rows = await readOwned(`SELECT status, version FROM "TradingRestriction" WHERE "userId"=$1::uuid`, [userId]);
    expect(rows[0].status).toBe('CLEAR');
    expect(Number(rows[0].version)).toBeGreaterThanOrEqual(3);

    const me = await prepared.exchange.request.get(`${api}/me/trading-restriction`, {
      headers: { Authorization: `Bearer ${prepared.exchange.first.accessToken}` },
    });
    expect(me.status()).toBe(200);
    expect((await me.json()).status).toBe('CLEAR');
  } finally {
    await prepared.exchange.dispose();
    await reviewer.dispose();
    await operators.dispose();
  }
});
