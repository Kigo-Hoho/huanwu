import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CaseDetailView, Role } from '@barter/contracts';
import { AfterSalesApi } from '../../features/after-sales/after-sales-api';
import { AuthenticatedApiClient, type RequestPort } from '../../lib/api-client';
import { Session } from '../../features/auth/session';
import { AfterSalesDetailPage } from './detail/index';
import { AfterSalesCreatePage } from './create/index';
import { OrderDetailPage } from '../orders/detail/index';
import { OrderApi } from '../../features/orders/order-api';
import { orderFixture, orderId as id } from '../../test/order-fixtures';
import { TradingFreezeBanner } from './trading-freeze-banner';
import { ReportForm } from './report-form';

const caseId = id(50);
function caseDetail(overrides: Partial<CaseDetailView> = {}): CaseDetailView {
  return {
    id: caseId, orderId: id(20), rootDisputeId: caseId, status: 'AWAITING_AGREEMENT', version: 2,
    reason: '物品与描述不符', currentResolutionVersion: 1, responseDeadline: null,
    agreementDeadline: '2099-10-10T00:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z',
    records: [{ id: id(51), kind: 'OPENED', actorKind: 'CUSTOMER', side: 'INITIATOR', description: '申请售后', createdAt: '2026-10-08T00:00:00.000Z' }],
    evidence: [],
    resolutions: [{
      id: id(52), number: 1, type: 'KEEP_WITH_COMPENSATION', reason: '保留并补偿', rulesVersion: 'phase4-v1',
      evidenceIds: [], itemSnapshotIds: [id(1), id(2)], responsibility: 'INITIATOR',
      originalFunds: [], returnPlan: [],
      compensationComponents: {
        originalDifferenceReversal: { amountFen: 0, payer: 'NONE' },
        initiatorExtraFen: 1000, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0,
      },
      netCompensation: { amountFen: 1000, payer: 'INITIATOR' }, orderOutcome: 'COMPLETE',
      createdAt: '2026-10-08T01:00:00.000Z', consents: [],
    }],
    compensation: [{
      obligationId: id(53), resolutionVersion: 1, paymentId: id(54), payerSide: 'INITIATOR', payeeSide: 'RECIPIENT',
      amountFen: 1000, currency: 'CNY', paymentDeadline: '2099-10-12T00:00:00.000Z', status: 'PENDING',
    }],
    ...overrides,
  };
}

function harness(detail: CaseDetailView = caseDetail(), roles: Role[] = ['CUSTOMER'], actor = id(10)) {
  let current = detail; let currentActor = actor;
  const calls: Parameters<RequestPort>[0][] = [];
  const stored = new Map<string, unknown>();
  const session = new Session({
    getStorageSync: key => stored.get(key),
    setStorageSync: (key, value) => { stored.set(key, value); },
    removeStorageSync: key => { stored.delete(key); },
  });
  session.setAccessToken('token', 900, actor);
  const request = vi.fn<RequestPort>(async options => {
    calls.push(options);
    if (options.url.endsWith('/api/me')) return { statusCode: 200, data: { id: currentActor, roles } };
    if (options.url.endsWith('/api/me/trading-restriction')) return { statusCode: 200, data: { status: 'CLEAR', version: 1, reason: null } };
    if (options.url.includes('/api/after-sales/') && options.method === 'GET' && !options.url.includes('/returns') && !options.url.includes('/compensation') && !options.url.includes('/return-address')) {
      return { statusCode: 200, data: current };
    }
    if (options.url.endsWith('/api/after-sales') || options.url.includes('/api/after-sales?')) {
      return { statusCode: 200, data: { items: [current], nextCursor: null } };
    }
    if (options.url.includes('/returns') && options.method === 'GET') return { statusCode: 200, data: [] };
    if (options.url.includes('/api/orders/') && options.method === 'GET') {
      const order = orderFixture({ id: current.orderId });
      order.parties[0]!.userId = currentActor;
      return { statusCode: 200, data: order };
    }
    const { records, evidence, resolutions, compensation, ...caseView } = current;
    return { statusCode: 200, data: { case: caseView, orderVersion: 5 } };
  });
  const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
  const api = new AfterSalesApi(client);
  return {
    api, request, calls, stored, session,
    setDetail: (value: CaseDetailView) => { current = value; },
    setActor: (value: string) => { currentActor = value; },
    orderApi: new OrderApi(client),
  };
}

describe('customer after-sales pages', () => {
  it('keeps resolution consent controls separate from keep-with-compensation confirmation', async () => {
    const h = harness(caseDetail({ status: 'EXECUTING' }));
    render(<AfterSalesDetailPage api={h.api} orderApi={h.orderApi} caseId={caseId} />);
    expect(await screen.findByRole('button', { name: '同意当前方案' })).toBeVisible();
    expect(screen.getByRole('button', { name: '拒绝当前方案' })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认保留物品' })).toBeVisible();
    expect(screen.getByRole('button', { name: '同意当前方案' })).not.toHaveTextContent('保留');
  });

  it('still shows after-sales entry on a frozen account order detail', async () => {
    const order = orderFixture({ status: 'AWAITING_ACCEPTANCE' });
    order.parties[0]!.incomingDeliveredAt = '2026-10-07T00:00:00.000Z';
    const stored = new Map<string, unknown>();
    const session = new Session({
      getStorageSync: key => stored.get(key),
      setStorageSync: (key, value) => { stored.set(key, value); },
      removeStorageSync: key => { stored.delete(key); },
    });
    session.setAccessToken('token', 900, id(10));
    const request = vi.fn<RequestPort>(async options => {
      if (options.url.endsWith('/api/me')) return { statusCode: 200, data: { id: id(10), roles: ['CUSTOMER'] } };
      if (options.url.endsWith('/api/me/trading-restriction')) return { statusCode: 200, data: { status: 'FROZEN', version: 2, reason: '风险审核中' } };
      if (options.url.includes('/api/orders/')) return { statusCode: 200, data: order };
      if (options.url.endsWith('/api/me/orders')) return { statusCode: 200, data: { items: [order], nextCursor: null } };
      return { statusCode: 200, data: order };
    });
    const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
    render(<OrderDetailPage api={new OrderApi(client)} afterSalesApi={new AfterSalesApi(client)} orderId={order.id} />);
    expect(await screen.findByText(/交易已冻结/)).toBeVisible();
    expect(screen.getByRole('button', { name: '申请售后' })).toBeVisible();
  });

  it('requires explicit reconfirmation after a 409 version conflict', async () => {
    const h = harness();
    render(<AfterSalesDetailPage api={h.api} orderApi={h.orderApi} caseId={caseId} />);
    await screen.findByRole('button', { name: '同意当前方案' });
    h.request.mockImplementationOnce(async options => {
      h.calls.push(options);
      return { statusCode: 409, data: { message: '版本冲突', code: 'AFTER_SALES_VERSION_CONFLICT' } };
    });
    h.setDetail(caseDetail({ version: 3 }));
    fireEvent.click(screen.getByRole('button', { name: '同意当前方案' }));
    await screen.findByText(/请核对后重新确认/);
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '同意当前方案' }));
    await waitFor(() => expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(2));
    expect(h.calls.filter(c => c.method === 'POST')[1]!.data).toMatchObject({ expectedCaseVersion: 3 });
  });

  it('does not expose simulation compensation complete outside allowed builds', async () => {
    const h = harness(caseDetail({
      status: 'EXECUTING',
      compensation: [{
        obligationId: id(53), resolutionVersion: 1, paymentId: id(54), payerSide: 'INITIATOR', payeeSide: 'RECIPIENT',
        amountFen: 1000, currency: 'CNY', paymentDeadline: '2099-10-12T00:00:00.000Z', status: 'PENDING',
      }],
    }));
    render(<AfterSalesDetailPage api={h.api} orderApi={h.orderApi} caseId={caseId} />);
    await screen.findByText('补偿');
    expect(screen.queryByRole('button', { name: /完成测试补偿/ })).not.toBeInTheDocument();
  });

  it('only offers report for legal visible targets', async () => {
    const submit = vi.fn().mockResolvedValue({ id: id(80), targetType: 'ITEM', targetId: id(1), reason: 'PROHIBITED_ITEM', description: '违禁', status: 'OPEN', version: 1, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' });
    render(<ReportForm targetType="ITEM" targetId={id(1)} expectedTargetVersion={1} visible onSubmit={submit} />);
    expect(screen.getByRole('button', { name: '提交举报' })).toBeVisible();
    const { rerender } = render(<ReportForm targetType="ITEM" targetId={id(1)} expectedTargetVersion={1} visible={false} onSubmit={submit} />);
    expect(screen.queryAllByRole('button', { name: '提交举报' })).toHaveLength(1);
  });

  it('create page opens a case from the order with an explicit reason', async () => {
    const h = harness();
    const navigate = vi.fn();
    render(<AfterSalesCreatePage api={h.api} orderId={id(20)} orderVersion={4} navigate={navigate} />);
    fireEvent.input(await screen.findByLabelText('售后原因'), { target: { value: '物品损坏' } });
    fireEvent.click(screen.getByRole('button', { name: '提交售后申请' }));
    await waitFor(() => expect(h.calls.some(c => String(c.url).endsWith('/after-sales') && c.method === 'POST')).toBe(true));
  });

  it('shows freeze banner without hiding after-sales navigation', async () => {
    const api = { getTradingRestriction: vi.fn().mockResolvedValue({ status: 'FROZEN', version: 2, reason: '风控审核' }) };
    render(<TradingFreezeBanner api={api as never} />);
    expect(await screen.findByText(/交易已冻结/)).toBeVisible();
    expect(screen.getByText(/仍可处理售后与退货/)).toBeVisible();
  });
});
