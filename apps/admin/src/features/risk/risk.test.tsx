import type { RiskReportDetail, RiskReportView, RiskTaskView } from '@barter/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import { RiskActionPage, RiskReportListPage, RiskTaskListPage } from './risk-pages';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true };

const report = (patch: Partial<RiskReportView> = {}): RiskReportView => ({
  id: id(1),
  targetType: 'ITEM',
  targetId: id(2),
  reason: 'PROHIBITED_ITEM',
  description: '违禁品举报',
  status: 'OPEN',
  version: 1,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...patch,
});

const task = (patch: Partial<RiskTaskView> = {}): RiskTaskView => ({
  id: id(3),
  orderId: id(4),
  caseId: null,
  reportId: id(1),
  blockerId: id(5),
  kind: 'FALSE_SHIPMENT',
  description: '异常运单待核验',
  status: 'OPEN',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...patch,
});

function bind(capability: 'MOBILE_LIMITED' | 'DESKTOP_PRIVILEGED') {
  window.sessionStorage.setItem(
    'barter-admin-operator-session',
    JSON.stringify({
      id: id(100),
      version: 1,
      deviceId: id(101),
      capability,
      expiresAt: '2026-10-20T12:00:00.000Z',
    }),
  );
}

afterEach(() => {
  window.sessionStorage.clear();
  window.innerWidth = 1024;
});

function baseClient(overrides: Record<string, unknown> = {}) {
  return {
    listReports: vi.fn().mockResolvedValue({ items: [report()], nextCursor: null }),
    getReport: vi.fn().mockResolvedValue({ ...report(), evidence: [], records: [] } satisfies RiskReportDetail),
    listRiskTasks: vi.fn().mockResolvedValue({ items: [task()], nextCursor: null }),
    claimReport: vi.fn(),
    requestReportEvidence: vi.fn(),
    concludeReport: vi.fn(),
    getRestriction: vi.fn().mockResolvedValue({ status: 'CLEAR', version: 1, reason: null }),
    freezeUser: vi.fn().mockResolvedValue({ resourceId: id(8), version: 2 }),
    unfreezeUser: vi.fn().mockResolvedValue({ resourceId: id(8), version: 3 }),
    unpublishItem: vi.fn(),
    clearItemRisk: vi.fn(),
    pauseOrder: vi.fn().mockResolvedValue({ resourceId: id(4), version: 2 }),
    clearOrderRisk: vi.fn(),
    onIdentityChange: () => () => undefined,
    clearSensitiveState: vi.fn(),
    ...overrides,
  };
}

it('renders risk report list as table then 390px cards', async () => {
  render(
    <MemoryRouter future={routerFuture}>
      <RiskReportListPage client={baseClient()} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('table', { name: '风险举报' })).toBeVisible();
  act(() => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
  });
  expect(screen.getByRole('list', { name: '风险举报' })).toBeVisible();
});

it('allows pause and freeze at 390px but does not open desktop recovery entry', async () => {
  window.innerWidth = 390;
  bind('MOBILE_LIMITED');
  render(
    <MemoryRouter future={routerFuture}>
      <RiskActionPage client={baseClient()} currentRoles={['REVIEWER']} />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('移动紧急止损')).toBeVisible();
  expect(screen.getByRole('button', { name: '冻结交易' })).toBeVisible();
  expect(screen.getByRole('button', { name: '暂停订单' })).toBeVisible();
  expect(screen.queryByLabelText('桌面恢复入口')).not.toBeInTheDocument();
  expect(screen.getByText(/390px 仅开放单项暂停\/冻结/)).toBeVisible();
});

it('shows forged privileged UI still fails clearly on API 403', async () => {
  window.innerWidth = 1024;
  bind('DESKTOP_PRIVILEGED');
  const freezeUser = vi.fn().mockRejectedValue(
    new ApiError(403, { code: 'FORBIDDEN', message: 'Current role cannot perform this action', requestId: 'x' }),
  );
  render(
    <MemoryRouter future={routerFuture}>
      <RiskActionPage client={baseClient({ freezeUser })} currentRoles={['REVIEWER']} forceShowPrivileged />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('用户 ID'), { target: { value: id(8) } });
  fireEvent.change(screen.getByLabelText('处置原因'), { target: { value: '紧急冻结' } });
  fireEvent.click(screen.getByRole('button', { name: '冻结交易' }));
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: '重新验证并执行' }));
  await waitFor(() => expect(screen.getByText(/FORBIDDEN：Current role cannot perform this action/)).toBeVisible());
});

it('hides risk actions for operations-only staff', async () => {
  render(
    <MemoryRouter future={routerFuture}>
      <RiskActionPage client={baseClient()} currentRoles={['OPERATIONS']} />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/当前角色不能执行风险处置/)).toBeVisible();
  expect(screen.queryByLabelText('移动紧急止损')).not.toBeInTheDocument();
});

it('lists risk tasks with blocker ids for clear-order construction', async () => {
  render(
    <MemoryRouter future={routerFuture}>
      <RiskTaskListPage client={baseClient()} />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('风险待办')).toHaveTextContent(id(5));
});

it('clears pending risk form state on identity change', async () => {
  let listener: (() => void) | undefined;
  const client = baseClient({
    onIdentityChange: (cb: () => void) => {
      listener = cb;
      return () => undefined;
    },
  });
  window.innerWidth = 1024;
  bind('DESKTOP_PRIVILEGED');
  render(
    <MemoryRouter future={routerFuture}>
      <RiskActionPage client={client} currentRoles={['SUPER_ADMIN']} />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText('处置原因'), { target: { value: '旧原因' } });
  act(() => listener?.());
  expect(screen.getByLabelText('处置原因')).toHaveValue('');
});
