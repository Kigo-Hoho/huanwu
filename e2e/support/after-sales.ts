import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CaseDetailView, OrderView, ResolutionInput } from '@barter/contracts';
import pg from 'pg';
import {
  api, app, courierHandover, createOrder, fundOrder, prepareAddresses, prepareConfirmedExchange, refresh, visibleText,
  type Exchange,
} from './orders';

export const adminApp = 'http://127.0.0.1:5173';
const DEVICE_COOKIE = 'barter_operator_device';
const password = () => {
  const value = process.env.E2E_REVIEWER_PASSWORD;
  if (!value) throw new Error('E2E_REVIEWER_PASSWORD required');
  return value;
};

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

export function operatorRequestHash(input: Record<string, unknown>): string {
  const filtered = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['password', 'grantId', 'sessionId', 'operatorAction', 'operatorActionContext'].includes(key)),
  );
  return createHash('sha256').update(JSON.stringify(normalize(filtered))).digest('hex');
}

async function readOwned(sql: string, values: unknown[]) {
  let url: string;
  try {
    url = JSON.parse(process.env.BARTER_E2E_API_ENV ?? '{}').DATABASE_URL;
    const name = new URL(url).pathname.slice(1);
    if (
      !/^barter_p3_[a-f0-9]{16}_[a-f0-9]{12}$/.test(name)
      || name !== process.env.BARTER_E2E_DATABASE_NAME
      || !process.env.BARTER_E2E_SOURCE_DATABASE_NAME
      || name === process.env.BARTER_E2E_SOURCE_DATABASE_NAME
      || !/^SELECT\s/.test(sql)
      || sql.includes(';')
    ) throw new Error();
  } catch {
    throw new Error('Read-only acceptance evidence requires the current owned database');
  }
  const client = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  try {
    await client.connect();
    return (await client.query(sql, values)).rows;
  } catch {
    throw new Error('Read-only acceptance evidence query failed');
  } finally {
    await client.end();
  }
}

export async function waitFundsReady(orderId: string) {
  await expect.poll(async () => {
    const rows = await readOwned(
      `SELECT status FROM "OutboxCommand" WHERE "orderId"=$1::uuid AND kind::text = ANY($2::text[])`,
      [orderId, ['CREATE_PAYMENT', 'CLOSE_PAYMENT', 'REFUND_PAYMENT', 'SETTLE_DIFFERENCE']],
    );
    return rows.length > 0 && rows.every((row: { status: string }) => row.status === 'SUCCEEDED');
  }, { timeout: 60_000 }).toBe(true);
}

async function waitSimulatedOperations(orderId: string, kind: string, minimum: number) {
  await expect.poll(async () => {
    const rows = await readOwned(
      `SELECT status FROM "SimulatedProviderOperation" WHERE "orderId"=$1::uuid AND kind::text = $2`,
      [orderId, kind],
    );
    return rows.length >= minimum;
  }, { timeout: 60_000 }).toBe(true);
}

export async function waitOutboxKinds(orderId: string, kinds: string[]) {
  await expect.poll(async () => {
    const rows = await readOwned(
      `SELECT kind, status FROM "OutboxCommand" WHERE "orderId"=$1::uuid AND kind::text = ANY($2::text[])`,
      [orderId, kinds],
    );
    return rows.filter((row: { status: string }) => row.status === 'PENDING' || row.status === 'PROCESSING').length;
  }, { timeout: 90_000 }).toBe(0);
}

type OperatorBundle = {
  context: BrowserContext;
  page: Page;
  email: string;
  token: string;
  sessionId: string;
  deviceId: string;
  dispose: () => Promise<void>;
};

async function passwordLogin(page: Page, email: string) {
  await page.goto(`${adminApp}/login`);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password());
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/admin/password') && r.request().method() === 'POST'),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  await expect(page.getByRole('link', { name: '售后工单' })).toBeVisible({ timeout: 30_000 });
}

async function securityBind(page: Page, email: string) {
  await page.goto(`${adminApp}/security/devices`);
  await page.getByLabel('运营邮箱', { exact: true }).fill(email);
  await page.getByLabel('运营密码', { exact: true }).fill(password());
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/admin/security/login') && r.request().method() === 'POST'),
    page.getByRole('button', { name: '绑定设备登录', exact: true }).click(),
  ]);
  const bound = await page.evaluate(() => {
    const raw = sessionStorage.getItem('barter-admin-operator-session');
    const session = sessionStorage.getItem('barter-admin-session');
    if (!raw || !session) throw new Error('bound operator session missing');
    const operator = JSON.parse(raw) as { id: string; deviceId: string; capability: string };
    const auth = JSON.parse(session) as { accessToken: string };
    return { sessionId: operator.id, deviceId: operator.deviceId, capability: operator.capability, token: auth.accessToken };
  });
  return bound;
}

function apiEnv() {
  return JSON.parse(process.env.BARTER_E2E_API_ENV ?? '{}') as Record<string, string>;
}

function bootstrapDevice(deviceId: string) {
  const env = { ...process.env, ...apiEnv(), BARTER_E2E_API_ENV: '' };
  const tsx = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const script = resolve(process.cwd(), 'apps/api/scripts/approve-operator-device.ts');
  const result = spawnSync(process.execPath, [tsx, script, deviceId, 'e2e owned bootstrap'], {
    cwd: resolve(process.cwd(), 'apps/api'),
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(result.status, result.stderr || result.stdout || 'bootstrap failed').toBe(0);
}

async function postBound(context: BrowserContext, token: string, path: string, data: unknown) {
  // Restored SameSite=Strict device cookies stay in the browser document but
  // are omitted by Playwright's request client and by fetch inside evaluate.
  const secret = await readDeviceCookie(context);
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: adminApp,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      Cookie: `${DEVICE_COOKIE}=${secret}`,
    },
    body: JSON.stringify(data),
  });
  return { status: response.status, text: await response.text() };
}

async function approveDeviceViaHttp(approver: OperatorBundle, targetDeviceId: string, expectedVersion: number) {
  const business = { expectedVersion, reason: 'e2e second desktop device' };
  const grant = await postBound(approver.context, approver.token, '/api/admin/security/grants', {
    action: 'APPROVE_DEVICE',
    resourceId: targetDeviceId,
    expectedVersions: { expectedVersion },
    requestHash: operatorRequestHash(business),
    password: password(),
  });
  expect(grant.status, grant.text).toBe(200);
  const grantBody = JSON.parse(grant.text) as { id: string };
  const approved = await postBound(approver.context, approver.token, `/api/admin/security/devices/${targetDeviceId}/approve`, {
    ...business,
    operatorAction: { sessionId: approver.sessionId, grantId: grantBody.id },
  });
  expect(approved.status, approved.text).toBe(200);
}

function desktopCookiePath(): string {
  const name = process.env.BARTER_E2E_DATABASE_NAME;
  if (!name || !/^barter_p3_[a-f0-9]{16}_[a-f0-9]{12}$/.test(name)) {
    throw new Error('Owned database name required before reusing a bootstrapped desktop');
  }
  return join(tmpdir(), `barter-e2e-desktop-${name}`);
}

async function rememberedDesktopCookie(): Promise<string | null> {
  try {
    const value = (await readFile(desktopCookiePath(), 'utf8')).trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function rememberDesktopCookie(value: string): Promise<void> {
  const path = desktopCookiePath();
  await mkdir(tmpdir(), { recursive: true });
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

async function installDeviceCookie(context: BrowserContext, value: string): Promise<void> {
  await context.addCookies([{
    name: DEVICE_COOKIE,
    value,
    url: `${adminApp}/api`,
    httpOnly: true,
    sameSite: 'Strict',
  }]);
}

async function readDeviceCookie(context: BrowserContext): Promise<string> {
  const cookies = (await context.cookies()).filter((item) => item.name === DEVICE_COOKIE && /^[a-f0-9]{64}$/.test(item.value));
  const preferred = cookies.filter((item) => item.path === '/api');
  const cookie = (preferred.length ? preferred : cookies).at(-1);
  if (!cookie) throw new Error('operator device cookie missing');
  return cookie.value;
}

export async function prepareOperators(browser: Browser) {
  const desktop = { viewport: { width: 1280, height: 800 } };
  const mobile = { viewport: { width: 390, height: 844 } };
  const existingDesktop = await rememberedDesktopCookie();

  const admin1Context = await browser.newContext(desktop);
  if (existingDesktop) await installDeviceCookie(admin1Context, existingDesktop);
  const admin1Page = await admin1Context.newPage();
  await passwordLogin(admin1Page, 'super-admin@barter.local');
  let bound = await securityBind(admin1Page, 'super-admin@barter.local');
  if (bound.capability !== 'DESKTOP_PRIVILEGED') {
    bootstrapDevice(bound.deviceId);
    bound = await securityBind(admin1Page, 'super-admin@barter.local');
    await rememberDesktopCookie(await readDeviceCookie(admin1Context));
  }
  expect(bound.capability).toBe('DESKTOP_PRIVILEGED');
  const admin1: OperatorBundle = {
    context: admin1Context,
    page: admin1Page,
    email: 'super-admin@barter.local',
    token: bound.token,
    sessionId: bound.sessionId,
    deviceId: bound.deviceId,
    dispose: async () => { await admin1Context.close(); },
  };

  const admin2Context = await browser.newContext(desktop);
  const admin2Page = await admin2Context.newPage();
  await passwordLogin(admin2Page, 'super-admin-two@barter.local');
  const pending = await securityBind(admin2Page, 'super-admin-two@barter.local');
  const versionRows = await readOwned(`SELECT version FROM "OperatorDevice" WHERE id=$1::uuid`, [pending.deviceId]);
  await approveDeviceViaHttp(admin1, pending.deviceId, Number(versionRows[0].version));
  const admin2Bound = await securityBind(admin2Page, 'super-admin-two@barter.local');
  expect(admin2Bound.capability).toBe('DESKTOP_PRIVILEGED');
  const admin2: OperatorBundle = {
    context: admin2Context,
    page: admin2Page,
    email: 'super-admin-two@barter.local',
    token: admin2Bound.token,
    sessionId: admin2Bound.sessionId,
    deviceId: admin2Bound.deviceId,
    dispose: async () => { await admin2Context.close(); },
  };

  const opsContext = await browser.newContext(mobile);
  const opsPage = await opsContext.newPage();
  await passwordLogin(opsPage, 'operations@barter.local');
  const opsBound = await securityBind(opsPage, 'operations@barter.local');
  const ops: OperatorBundle = {
    context: opsContext,
    page: opsPage,
    email: 'operations@barter.local',
    token: opsBound.token,
    sessionId: opsBound.sessionId,
    deviceId: opsBound.deviceId,
    dispose: async () => { await opsContext.close(); },
  };

  return {
    admin1,
    admin2,
    ops,
    dispose: async () => {
      await Promise.all([admin1.dispose(), admin2.dispose(), ops.dispose()]);
    },
  };
}

export async function openAfterSalesCase(exchange: Exchange, orderId: string, reason: string) {
  await exchange.initiator.goto(`${app}/pages/orders/detail/index?id=${orderId}`);
  await expect(exchange.initiator.getByRole('button', { name: '申请售后', exact: true })).toBeVisible();
  await exchange.initiator.getByRole('button', { name: '申请售后', exact: true }).click();
  await expect(exchange.initiator.getByText('申请售后', { exact: true })).toBeVisible();
  await exchange.initiator.getByLabel('售后原因', { exact: true }).locator('input').fill(reason);
  const opened = exchange.initiator.waitForResponse(
    (r) => r.url().includes(`/api/orders/${orderId}/after-sales`) && r.request().method() === 'POST',
  );
  await exchange.initiator.getByRole('button', { name: '提交售后申请', exact: true }).click();
  const response = await opened;
  expect(response.ok(), `open after-sales HTTP ${response.status()}`).toBe(true);
  const body = await response.json();
  const caseId = body.case.id as string;
  await expect(exchange.initiator.getByText(`工单号：${caseId}`).or(exchange.initiator.getByText(caseId))).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
  await exchange.initiator.goto(`${app}/pages/after-sales/detail/index?id=${caseId}&orderVersion=${body.orderVersion}`);
  await exchange.recipient.goto(`${app}/pages/after-sales/detail/index?id=${caseId}&orderVersion=${body.orderVersion}`);
  return { caseId, orderVersion: body.orderVersion as number };
}

export async function uploadEvidence(page: Page, description: string) {
  await page.reload();
  await expect(page.getByLabel('证据说明', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('证据说明', { exact: true }).locator('input').fill(description);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /选择图片/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([
    resolve(process.cwd(), 'e2e/fixtures/item-1.jpg'),
    resolve(process.cwd(), 'e2e/fixtures/item-2.jpg'),
  ]);
  await expect(page.getByRole('button', { name: /选择图片（2\/9）/ })).toBeVisible({ timeout: 15_000 });
  const uploaded = page.waitForResponse(
    (r) => r.url().includes('/api/after-sales/') && r.url().includes('/evidence') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '上传证据', exact: true }).click();
  const response = await uploaded;
  expect(response.ok(), `evidence HTTP ${response.status()} ${await response.text()}`).toBe(true);
}

export async function proposeReturnViaUi(ops: OperatorBundle, caseId: string) {
  await ops.page.goto(`${adminApp}/after-sales/${caseId}`);
  await expect(ops.page.getByRole('heading', { name: '售后工单详情' })).toBeVisible();
  // The draft defaults to 退回原物. Opening the 390px select never finishes its click.
  await expect(ops.page.locator('.ant-select-selection-item', { hasText: '退回原物' })).toBeVisible();
  await ops.page.getByLabel('方案原因').fill('e2e 退回原物方案');
  const proposed = ops.page.waitForResponse(
    (r) => r.url().includes(`/api/admin/after-sales/${caseId}/resolutions`) && r.request().method() === 'POST',
  );
  await ops.page.getByRole('button', { name: '提交方案草稿', exact: true }).click();
  const response = await proposed;
  expect(response.ok(), `propose HTTP ${response.status()} ${await response.text()}`).toBe(true);
}

export async function proposeKeepViaHttp(ops: OperatorBundle, caseId: string, amountFen: number) {
  const detail = await ops.page.request.get(`${adminApp}/api/admin/after-sales/${caseId}`, {
    headers: { Authorization: `Bearer ${ops.token}`, Origin: adminApp },
  });
  expect(detail.status()).toBe(200);
  const body = await detail.json();
  const context = body.resolutionContext;
  expect(context).toBeTruthy();
  const input: ResolutionInput = {
    expectedCaseVersion: body.version,
    expectedOrderVersion: context.orderVersion,
    resolutionVersion: (body.currentResolutionVersion ?? 0) + 1,
    type: 'KEEP_WITH_COMPENSATION',
    reason: 'e2e 保留并补偿',
    rulesVersion: 'phase4-simulation-v1',
    evidenceIds: (body.evidence ?? []).map((e: { id: string }) => e.id),
    itemSnapshotIds: context.itemSnapshots.map((s: { id: string }) => s.id),
    responsibility: 'UNDETERMINED',
    originalFunds: context.originalPayments.map((p: { paymentIntentId: string }) => ({
      paymentIntentId: p.paymentIntentId,
      destination: 'REFUND_PAYER' as const,
    })),
    returnPlan: [],
    compensationComponents: {
      originalDifferenceReversal: { amountFen: 0, payer: 'NONE' },
      initiatorExtraFen: amountFen,
      recipientExtraFen: 0,
      initiatorShippingFen: 0,
      recipientShippingFen: 0,
    },
    netCompensation: { amountFen, payer: 'INITIATOR' },
    orderOutcome: 'COMPLETE',
  };
  const proposed = await ops.page.request.post(`${adminApp}/api/admin/after-sales/${caseId}/resolutions`, {
    headers: {
      Authorization: `Bearer ${ops.token}`,
      Origin: adminApp,
      'Idempotency-Key': `propose-keep:${caseId}:v${body.version}`,
    },
    data: input,
  });
  expect(proposed.status(), await proposed.text()).toBe(200);
}

export async function consentBoth(exchange: Exchange, caseId: string) {
  for (const page of [exchange.initiator, exchange.recipient]) {
    await page.goto(`${app}/pages/after-sales/detail/index?id=${caseId}`);
    await expect(page.getByRole('button', { name: '同意当前方案', exact: true })).toBeVisible({ timeout: 30_000 });
    const pending = page.waitForResponse(
      (r) => r.url().includes(`/api/after-sales/${caseId}/consent`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '同意当前方案', exact: true }).click();
    const response = await pending;
    expect(response.ok(), `consent HTTP ${response.status()}`).toBe(true);
  }
}

export async function saveReturnAddresses(exchange: Exchange, caseId: string) {
  for (const [index, session] of [exchange.first, exchange.second].entries()) {
    const detailRes = await exchange.request.get(`${api}/after-sales/${caseId}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(detailRes.status()).toBe(200);
    const detail = await detailRes.json() as CaseDetailView;
    const order = await exchange.request.get(`${api}/orders/${detail.orderId}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const orderBody = await order.json() as OrderView;
    const saved = await exchange.request.post(`${api}/after-sales/${caseId}/return-address`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Idempotency-Key': randomUUID(),
      },
      data: {
        expectedCaseVersion: detail.version,
        expectedOrderVersion: orderBody.version,
        resolutionVersion: detail.currentResolutionVersion ?? 1,
        recipientName: `归还${index}`,
        phone: `1390000111${index}`,
        region: '测试省测试市',
        detail: `归还街道${index}号`,
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
  }
}

async function reauthAndClick(page: Page, buttonName: string) {
  await page.getByLabel('审批操作原因').fill(`e2e ${buttonName}`);
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await expect(page.getByLabel('管理员密码')).toBeVisible();
  await page.getByLabel('管理员密码').fill(password());
  const pending = page.waitForResponse(
    (r) => r.url().includes('/api/admin/after-sales/') && r.request().method() === 'POST'
      && (r.url().includes('/approvals') || r.url().includes('/execute')),
  );
  await page.getByRole('button', { name: '重新验证并执行', exact: true }).click();
  const response = await pending;
  expect(response.ok(), `${buttonName} HTTP ${response.status()} ${await response.text()}`).toBe(true);
}

export async function dualApproveAndExecute(admin1: OperatorBundle, admin2: OperatorBundle, caseId: string) {
  for (const admin of [admin1, admin2]) {
    await admin.page.setViewportSize({ width: 1280, height: 800 });
    await admin.page.goto(`${adminApp}/after-sales/${caseId}`);
    await expect(admin.page.getByLabel('资金审批入口')).toBeVisible({ timeout: 30_000 });
    await reauthAndClick(admin.page, '批准资金方案');
  }
  await admin1.page.goto(`${adminApp}/after-sales/${caseId}`);
  await expect(admin1.page.getByText('两名管理员批准已齐')).toBeVisible({ timeout: 30_000 });
  await reauthAndClick(admin1.page, '执行资金方案');
}

export async function closeOriginalShipments(exchange: Exchange, caseId: string, orderId: string) {
  await waitSimulatedOperations(orderId, 'CLOSE_OR_INTERCEPT', 2);
  const shipments = await readOwned(
    `SELECT id, side FROM "Shipment" WHERE "orderId"=$1::uuid`,
    [orderId],
  );
  expect(shipments.length).toBeGreaterThanOrEqual(2);
  for (const shipment of shipments as { id: string; side: string }[]) {
    const session = shipment.side === 'INITIATOR' ? exchange.first : exchange.second;
    const detailRes = await exchange.request.get(`${api}/after-sales/${caseId}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const detail = await detailRes.json() as CaseDetailView;
    const orderRes = await exchange.request.get(`${api}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const order = await orderRes.json() as OrderView;
    const closed = await exchange.request.post(`${api}/after-sales/${caseId}/returns/simulated-progress`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Idempotency-Key': randomUUID(),
      },
      data: {
        expectedCaseVersion: detail.version,
        expectedOrderVersion: order.version,
        resolutionVersion: detail.currentResolutionVersion ?? 1,
        shipmentId: shipment.id,
        kind: 'ORIGINAL_SHIPMENT_CLOSED',
        outcome: 'DELIVERED',
      },
    });
    expect(closed.status(), await closed.text()).toBe(200);
  }
  await waitOutboxKinds(orderId, ['CLOSE_OR_INTERCEPT']);
}

export async function registerAndProgressReturns(exchange: Exchange, caseId: string, orderId: string) {
  for (const [page, session] of [[exchange.initiator, exchange.first], [exchange.recipient, exchange.second]] as const) {
    await page.goto(`${app}/pages/after-sales/detail/index?id=${caseId}`);
    await expect(page.getByRole('button', { name: '登记退货寄出', exact: true })).toBeVisible({ timeout: 60_000 });
    const tracking = `RTN${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 20)}`;
    await page.getByLabel('承运商', { exact: true }).locator('input').fill('SF');
    await page.getByLabel('运单号', { exact: true }).locator('input').fill(tracking);
    const registered = page.waitForResponse(
      (r) => r.url().includes(`/api/after-sales/${caseId}/returns/shipment`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登记退货寄出', exact: true }).click();
    const response = await registered;
    expect(response.ok(), `register return HTTP ${response.status()} ${await response.text()}`).toBe(true);
  }

  await waitSimulatedOperations(orderId, 'VERIFY_RETURN', 2);
  const returnShipments = await readOwned(
    `SELECT rs.id, rs."holderSide" FROM "ReturnShipment" rs
     JOIN "ResolutionVersion" rv ON rv.id = rs."resolutionId"
     JOIN "AfterSalesCase" c ON c.id = rv."caseId"
     WHERE c.id=$1::uuid`,
    [caseId],
  );
  expect(returnShipments.length).toBeGreaterThanOrEqual(2);
  for (const progress of ['COLLECTED', 'DELIVERED'] as const) {
    for (const shipment of returnShipments as { id: string; holderSide: string }[]) {
      const session = shipment.holderSide === 'INITIATOR' ? exchange.first : exchange.second;
      const detailRes = await exchange.request.get(`${api}/after-sales/${caseId}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const detail = await detailRes.json() as CaseDetailView;
      const orderRes = await exchange.request.get(`${api}/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const order = await orderRes.json() as OrderView;
      const advanced = await exchange.request.post(`${api}/after-sales/${caseId}/returns/simulated-progress`, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          expectedCaseVersion: detail.version,
          expectedOrderVersion: order.version,
          resolutionVersion: detail.currentResolutionVersion ?? 1,
          shipmentId: shipment.id,
          kind: 'RETURN_PROGRESS',
          progress,
        },
      });
      expect(advanced.status(), await advanced.text()).toBe(200);
    }
  }

  for (const page of [exchange.initiator, exchange.recipient]) {
    const open = async () => {
      await page.goto(`${app}/pages/after-sales/detail/index?id=${caseId}`);
      // The return list arrives with the detail payload. Counting buttons before
      // that paint treats a second delivered obligation as already confirmed.
      await expect(page.getByText(/持有 /).first()).toBeVisible({ timeout: 60_000 });
    };
    await open();
    while (await page.getByRole('button', { name: '确认收到退货', exact: true }).count()) {
      const pending = page.waitForResponse(
        (r) => r.url().includes(`/api/after-sales/${caseId}/returns/`) && r.url().includes('/returns/confirmation') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '确认收到退货', exact: true }).first().click();
      const response = await pending;
      expect(response.ok(), `confirm return HTTP ${response.status()} ${await response.text()}`).toBe(true);
      await open();
    }
  }
  const progress = await readOwned(
    `SELECT rp.status FROM "ReturnProgress" rp
     JOIN "ReturnObligation" ro ON ro.id = rp."obligationId"
     JOIN "ResolutionVersion" rv ON rv.id = ro."resolutionId"
     WHERE rv."caseId" = $1::uuid`,
    [caseId],
  );
  const statuses = progress.map((row: { status: string }) => row.status);
  expect(statuses.length, 'return obligations').toBeGreaterThan(0);
  expect(
    statuses.every((status: string) => ['CONFIRMED', 'INTERCEPTED', 'UNRETURNABLE'].includes(status)),
    statuses.join(','),
  ).toBe(true);
}

export async function confirmKeepBoth(exchange: Exchange, caseId: string) {
  for (const page of [exchange.initiator, exchange.recipient]) {
    await page.goto(`${app}/pages/after-sales/detail/index?id=${caseId}`);
    await expect(page.getByRole('button', { name: '确认保留物品', exact: true })).toBeVisible({ timeout: 60_000 });
    const pending = page.waitForResponse(
      (r) => r.url().includes(`/api/after-sales/${caseId}/keep-confirmation`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '确认保留物品', exact: true }).click();
    const response = await pending;
    expect(response.ok(), `confirm keep HTTP ${response.status()}`).toBe(true);
  }
}

export async function payCompensation(exchange: Exchange, caseId: string) {
  await exchange.initiator.goto(`${app}/pages/after-sales/detail/index?id=${caseId}`);
  await expect(exchange.initiator.getByRole('button', { name: '发起补偿付款', exact: true })).toBeVisible({ timeout: 60_000 });
  const requested = exchange.initiator.waitForResponse(
    (r) => r.url().includes(`/api/after-sales/${caseId}/compensation/payments`) && r.request().method() === 'POST',
  );
  await exchange.initiator.getByRole('button', { name: '发起补偿付款', exact: true }).click();
  expect((await requested).ok()).toBe(true);
  await expect.poll(async () => {
    const rows = await readOwned(
      `SELECT spo.status FROM "SimulatedProviderOperation" spo
       JOIN "CompensationPayment" cp ON cp."businessNo" = spo."businessNo"
       JOIN "CompensationObligation" co ON co.id = cp."obligationId"
       JOIN "ResolutionVersion" rv ON rv.id = co."resolutionId"
       WHERE rv."caseId"=$1::uuid AND spo.kind::text = 'CREATE_COMPENSATION'`,
      [caseId],
    );
    return rows[0]?.status ?? null;
  }, { timeout: 60_000 }).toBe('PENDING');
  await exchange.initiator.goto(`${app}/pages/after-sales/detail/index?id=${caseId}`);
  await expect(exchange.initiator.getByRole('button', { name: '完成测试补偿', exact: true })).toBeVisible({ timeout: 60_000 });
  const completed = exchange.initiator.waitForResponse(
    (r) => r.url().includes('/api/testing/compensation/') && r.request().method() === 'POST',
  );
  await exchange.initiator.getByRole('button', { name: '完成测试补偿', exact: true }).click();
  const response = await completed;
  expect(response.ok(), `complete compensation HTTP ${response.status()} ${await response.text()}`).toBe(true);
}

export async function assertThirdPartyEvidenceDenied(browser: Browser, caseId: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript((code) => Object.assign(globalThis, { __BARTER_ACCEPTANCE_IDENTITY_CODE__: code }), 'e2e-customer-three-code');
    const auth = page.waitForResponse((r) => r.url() === `${api}/auth/wechat` && r.request().method() === 'POST');
    await page.goto(`${app}/pages/items/mine/index`);
    const authenticated = await auth;
    expect(authenticated.status()).toBe(201);
    const session = await authenticated.json();
    const evidenceRows = await readOwned(
      `SELECT id FROM "CaseEvidence" WHERE "caseId"=$1::uuid LIMIT 1`,
      [caseId],
    );
    expect(evidenceRows.length).toBe(1);
    const denied = await page.request.get(`${api}/evidence/${evidenceRows[0].id}/content?variant=preview`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(denied.status()).toBe(404);
  } finally {
    await context.close();
  }
}

export async function assertItemsNotRelisted(exchange: Exchange) {
  for (const item of exchange.items) {
    expect((await exchange.request.get(`${api}/items/${item.id}`)).status()).toBe(404);
    const session = item.ownerId === exchange.first.user.id ? exchange.first : exchange.second;
    const own = await exchange.request.get(`${api}/me/items/${item.id}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(own.status()).toBe(200);
    const body = await own.json();
    expect(['UNPUBLISHED', 'INACTIVE']).toContain(body.status);
    const persisted = await readOwned(`SELECT status FROM "Item" WHERE id=$1::uuid`, [item.id]);
    expect(persisted[0].status).toBe('INACTIVE');
  }
}

export async function assertNoSecondPaymentCharge(orderId: string) {
  const payments = await readOwned(
    `SELECT side, purpose, status, COUNT(*)::int AS count FROM "PaymentIntent" WHERE "orderId"=$1::uuid GROUP BY side, purpose, status`,
    [orderId],
  );
  const creates = await readOwned(
    `SELECT COUNT(*)::int AS count FROM "OutboxCommand" WHERE "orderId"=$1::uuid AND kind='CREATE_PAYMENT'`,
    [orderId],
  );
  expect(creates[0].count).toBeLessThanOrEqual(2);
  expect(payments.every((row: { count: number }) => row.count === 1)).toBe(true);
}


export async function prepareMobileReviewer(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await passwordLogin(page, 'reviewer@barter.local');
  const bound = await securityBind(page, 'reviewer@barter.local');
  expect(bound.capability).toBe('MOBILE_LIMITED');
  return {
    context,
    page,
    email: 'reviewer@barter.local',
    token: bound.token,
    sessionId: bound.sessionId,
    deviceId: bound.deviceId,
    dispose: async () => { await context.close(); },
  };
}

export async function prepareDeliveredCourier(browser: Browser, request: import('@playwright/test').APIRequestContext, offeredCount = 2) {
  const exchange = await prepareConfirmedExchange({ browser, request, mode: 'COURIER', offeredCount });
  const orderId = await createOrder(exchange);
  await prepareAddresses(exchange, orderId);
  await fundOrder(exchange, orderId);
  await courierHandover(exchange, orderId);
  await waitFundsReady(orderId);
  for (const page of [exchange.initiator, exchange.recipient]) {
    const order = await refresh(page);
    expect(order.parties.every((party) => Boolean(party.incomingDeliveredAt))).toBe(true);
    await expect(visibleText(page, '待双方验收').or(visibleText(page, '待验收'))).toBeVisible().catch(async () => {
      await expect(visibleText(page, '运输中').or(visibleText(page, '待双方履约'))).toBeVisible();
    });
  }
  return { exchange, orderId };
}

export { readOwned, api, app, visibleText, refresh };
