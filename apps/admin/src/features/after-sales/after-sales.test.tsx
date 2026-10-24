import type { AdminCaseDetailView, AdminCaseView } from '@barter/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRouter } from '../../app/router';
import { ApiError } from '../../lib/api-client';
import { ApprovalActions } from './approval-actions';
import { CaseDetailPage } from './case-detail-page';
import { CaseListPage } from './case-list-page';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true };

const caseView = (patch: Partial<AdminCaseView> = {}): AdminCaseView => ({
  id: id(1),
  orderId: id(2),
  rootDisputeId: id(3),
  status: 'UNDER_REVIEW',
  version: 2,
  reason: '物品与描述不符',
  currentResolutionVersion: 1,
  responseDeadline: null,
  agreementDeadline: null,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T01:00:00.000Z',
  ...patch,
});

const detail = (patch: Partial<AdminCaseDetailView> = {}): AdminCaseDetailView => ({
  ...caseView(),
  records: [
    {
      id: id(40),
      kind: 'RESOLUTION_APPROVED',
      actorKind: 'PLATFORM',
      side: null,
      description: '管理员甲批准资金方案',
      createdAt: '2026-10-20T02:00:00.000Z',
    },
    {
      id: id(41),
      kind: 'RESOLUTION_APPROVED',
      actorKind: 'PLATFORM',
      side: null,
      description: '管理员乙批准资金方案',
      createdAt: '2026-10-20T03:00:00.000Z',
    },
    {
      id: id(42),
      kind: 'CASE_OPENED',
      actorKind: 'CUSTOMER',
      side: 'INITIATOR',
      description: '用户申请售后',
      createdAt: '2026-10-20T00:00:00.000Z',
    },
  ],
  evidence: [{ id: id(50), description: '瑕疵近照', mimeType: 'image/jpeg', bytes: 1200, width: 100, height: 80, sha256: 'a'.repeat(64), createdAt: '2026-10-20T00:30:00.000Z' }],
  resolutions: [
    {
      id: id(60),
      number: 1,
      type: 'RETURN_ORIGINALS',
      reason: '退回原物',
      rulesVersion: 'phase4-admin-v1',
      evidenceIds: [id(50)],
      itemSnapshotIds: [id(70), id(71)],
      responsibility: 'UNDETERMINED',
      originalFunds: [{ paymentIntentId: id(80), destination: 'REFUND_PAYER' }],
      returnPlan: [
        { itemSnapshotId: id(70), outcome: 'RETURN_ORIGINAL' },
        { itemSnapshotId: id(71), outcome: 'UNDELIVERED' },
      ],
      compensationComponents: {
        originalDifferenceReversal: { amountFen: 0, payer: 'NONE' },
        initiatorExtraFen: 0,
        recipientExtraFen: 0,
        initiatorShippingFen: 0,
        recipientShippingFen: 0,
      },
      netCompensation: { amountFen: 0, payer: 'NONE' },
      orderOutcome: 'CANCEL',
      createdAt: '2026-10-20T01:30:00.000Z',
      consents: [],
    },
  ],
  resolutionContext: {
    orderStatus: 'ON_HOLD',
    orderVersion: 4,
    itemSnapshots: [
      { id: id(70), itemId: id(90), side: 'INITIATOR', deliveryState: 'DELIVERED' },
      { id: id(71), itemId: id(91), side: 'RECIPIENT', deliveryState: 'UNDELIVERED' },
    ],
    originalPayments: [
      {
        paymentIntentId: id(80),
        side: 'INITIATOR',
        purpose: 'DEPOSIT',
        status: 'PAID',
        amountFen: 1000,
        collectedFen: 1000,
        refundedFen: 0,
        settledFen: 0,
      },
    ],
    originalDifference: { amountFen: 0, payer: 'NONE', settlementStatus: 'UNPAID' },
  },
  ...patch,
});

function session(roles: string[] = ['SUPER_ADMIN']) {
  window.sessionStorage.setItem(
    'barter-admin-session',
    JSON.stringify({ accessToken: 'operator-token', expiresAt: Date.now() + 60_000, user: { id: id(90), roles } }),
  );
}

function bindDesktop() {
  window.sessionStorage.setItem(
    'barter-admin-operator-session',
    JSON.stringify({
      id: id(100),
      version: 1,
      deviceId: id(101),
      capability: 'DESKTOP_PRIVILEGED',
      expiresAt: '2026-10-20T12:00:00.000Z',
    }),
  );
}

function bindMobile() {
  window.sessionStorage.setItem(
    'barter-admin-operator-session',
    JSON.stringify({
      id: id(102),
      version: 1,
      deviceId: id(103),
      capability: 'MOBILE_LIMITED',
      expiresAt: '2026-10-20T12:00:00.000Z',
    }),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.innerWidth = 1024;
});

it('exposes after-sales routes through the operator router', async () => {
  session();
  window.history.replaceState({}, '', '/after-sales');
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/admin/session')
      ? json({ id: id(90), roles: ['SUPER_ADMIN'] })
      : url.includes('/admin/items')
        ? json([])
        : url.includes('/admin/after-sales') && !url.match(/after-sales\/[^/]+$/)
          ? json({ items: [caseView()], nextCursor: null })
          : url.includes('/admin/after-sales/')
            ? json(detail())
            : json({ items: [], nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<AppRouter />);
  expect(await screen.findByRole('heading', { name: '售后工单' })).toBeVisible();
  expect(screen.getByRole('link', { name: '售后工单' })).toHaveAttribute('href', '/after-sales');
});

it('renders desktop table and 390px cards for case list', async () => {
  const client = { listCases: vi.fn().mockResolvedValue({ items: [caseView()], nextCursor: null }) };
  render(
    <MemoryRouter future={routerFuture}>
      <CaseListPage client={client} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('table', { name: '售后工单' })).toBeVisible();
  act(() => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
  });
  expect(screen.getByRole('list', { name: '售后工单' })).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('shows platform timeline without disguising platform as customer and shows dual approvals', async () => {
  const client = {
    getCase: vi.fn().mockResolvedValue(detail()),
    requestEvidence: vi.fn(),
    rejectCase: vi.fn(),
    proposeResolution: vi.fn(),
    approveFunds: vi.fn(),
    executeFunds: vi.fn(),
    adjudicate: vi.fn(),
    onIdentityChange: () => () => undefined,
    clearSensitiveState: vi.fn(),
    getIdentityEpoch: () => 0,
  };
  session();
  bindDesktop();
  render(
    <MemoryRouter future={routerFuture}>
      <CaseDetailPage client={client} caseId={id(1)} currentRoles={['SUPER_ADMIN']} />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('平台处理时间线')).toBeVisible();
  expect(screen.getAllByText(/平台（非用户）/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByLabelText('批准记录 1')).toHaveTextContent('管理员甲批准资金方案');
  expect(screen.getByLabelText('批准记录 2')).toHaveTextContent('管理员乙批准资金方案');
  expect(screen.getByText(/两名管理员批准已齐/)).toBeVisible();
  expect(screen.getByLabelText('归还逐项计划')).toHaveTextContent('RETURN_ORIGINAL');
  expect(screen.getByLabelText('资金原号核验进度')).toHaveTextContent(id(80));
});

it('hides funds approval entry at 390px while still rendering the detail', async () => {
  window.innerWidth = 390;
  bindMobile();
  session();
  const client = {
    getCase: vi.fn().mockResolvedValue(detail()),
    requestEvidence: vi.fn(),
    rejectCase: vi.fn(),
    proposeResolution: vi.fn(),
    approveFunds: vi.fn(),
    executeFunds: vi.fn(),
    adjudicate: vi.fn(),
    onIdentityChange: () => () => undefined,
    clearSensitiveState: vi.fn(),
    getIdentityEpoch: () => 0,
  };
  render(
    <MemoryRouter future={routerFuture}>
      <CaseDetailPage client={client} caseId={id(1)} currentRoles={['SUPER_ADMIN']} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { name: '售后工单详情' })).toBeVisible();
  expect(screen.queryByLabelText('资金审批入口')).not.toBeInTheDocument();
  expect(screen.getByText(/资金审批入口未开放/)).toBeVisible();
});

it('keeps funds entry closed for operations and surfaces forged-client 403 clearly', async () => {
  session(['OPERATIONS']);
  bindDesktop();
  const approveFunds = vi.fn().mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN', message: 'Current role cannot perform this action', requestId: 'r1' }));
  const client = {
    getCase: vi.fn().mockResolvedValue(detail()),
    requestEvidence: vi.fn(),
    rejectCase: vi.fn(),
    proposeResolution: vi.fn(),
    approveFunds,
    executeFunds: vi.fn(),
    adjudicate: vi.fn(),
    onIdentityChange: () => () => undefined,
    clearSensitiveState: vi.fn(),
    getIdentityEpoch: () => 0,
  };
  render(
    <MemoryRouter future={routerFuture}>
      <CaseDetailPage client={client} caseId={id(1)} currentRoles={['OPERATIONS']} />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/客服不可执行资金批准或资金执行/)).toBeVisible();
  expect(screen.queryByLabelText('资金审批入口')).not.toBeInTheDocument();

  render(
    <MemoryRouter future={routerFuture}>
      <ApprovalActions
        detail={detail()}
        currentRoles={['SUPER_ADMIN']}
        forceShowFundsEntry
        client={client}
        onUpdated={() => undefined}
      />
    </MemoryRouter>,
  );
  const reasonInputs = screen.getAllByLabelText('审批操作原因');
  fireEvent.change(reasonInputs[reasonInputs.length - 1]!, { target: { value: '同意退款' } });
  fireEvent.click(screen.getAllByRole('button', { name: '批准资金方案' }).at(-1)!);
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '重新验证并执行' }));
  expect(await screen.findByText(/FORBIDDEN：Current role cannot perform this action/)).toBeVisible();
});

it('discards late detail after identity change and clears form state', async () => {
  let resolveOld!: (value: AdminCaseDetailView) => void;
  const identityListeners = new Set<() => void>();
  let epoch = 0;
  const client = {
    getCase: vi
      .fn()
      .mockImplementationOnce(() => new Promise<AdminCaseDetailView>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(detail({ id: id(9), reason: '新账号工单' })),
    requestEvidence: vi.fn(),
    rejectCase: vi.fn(),
    proposeResolution: vi.fn(),
    approveFunds: vi.fn(),
    executeFunds: vi.fn(),
    adjudicate: vi.fn(),
    onIdentityChange: (listener: () => void) => {
      identityListeners.add(listener);
      return () => {
        identityListeners.delete(listener);
      };
    },
    clearSensitiveState: vi.fn(() => {
      epoch += 1;
      for (const listener of [...identityListeners]) listener();
    }),
    getIdentityEpoch: () => epoch,
  };
  session();
  bindDesktop();
  render(
    <MemoryRouter future={routerFuture} initialEntries={[`/after-sales/${id(1)}`]}>
      <Routes>
        <Route path="/after-sales/:caseId" element={<CaseDetailPage client={client} currentRoles={['SUPER_ADMIN']} />} />
      </Routes>
    </MemoryRouter>,
  );
  act(() => {
    client.clearSensitiveState();
  });
  expect(await screen.findByText(/新账号工单/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('补证原因'), { target: { value: '请补近照' } });
  act(() => {
    client.clearSensitiveState();
  });
  await waitFor(() => expect(screen.queryByDisplayValue('请补近照')).not.toBeInTheDocument());
  await act(async () => {
    resolveOld(detail({ reason: '旧详情不得渲染' }));
  });
  expect(screen.queryByText('旧详情不得渲染')).not.toBeInTheDocument();
});

it('shows APPROVAL_REQUIRED / risk block messages from funds execute failures', async () => {
  session();
  bindDesktop();
  const executeFunds = vi.fn().mockRejectedValue(
    new ApiError(409, { code: 'APPROVAL_REQUIRED', message: 'Still missing a second approval', requestId: 'r2' }),
  );
  const client = {
    getCase: vi.fn().mockResolvedValue(detail()),
    approveFunds: vi.fn(),
    executeFunds,
    adjudicate: vi.fn(),
    onIdentityChange: () => () => undefined,
    clearSensitiveState: vi.fn(),
  };
  render(
    <MemoryRouter future={routerFuture}>
      <ApprovalActions detail={detail()} currentRoles={['SUPER_ADMIN']} client={client} onUpdated={() => undefined} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('审批操作原因'), { target: { value: '执行退款' } });
  fireEvent.click(screen.getByRole('button', { name: '执行资金方案' }));
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '重新验证并执行' }));
  await waitFor(() => expect(screen.getByText(/APPROVAL_REQUIRED：Still missing a second approval/)).toBeVisible());
  expect(screen.getAllByText(/APPROVAL_REQUIRED：Still missing a second approval/)).toHaveLength(1);
});
