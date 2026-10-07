import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrderView } from '@barter/contracts';
import { AppRouter } from '../../app/router';
import { createApiClient } from '../../lib/api-client';
import { OrderListPage } from './order-list-page';
import { OrderDetailPage } from './order-detail-page';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture = (patch: Partial<OrderView> = {}): OrderView => ({
  id: id(1), proposalId: id(2), proposalVersionId: id(3), initiatorId: id(10), recipientId: id(11), status: 'ON_HOLD', version: 2,
  rules: { version: 'phase3-test-v1', depositFen: 1000, feeFen: 0, detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72 },
  terms: { differenceFen: 500, payer: 'INITIATOR', deliveryMode: 'COURIER', initiatorShippingFen: 500, recipientShippingFen: 600 },
  items: [10, 11].map((n, i) => ({ itemId: id(n + 20), ownerId: id(n), itemVersion: 1, side: i === 0 ? 'INITIATOR' : 'RECIPIENT', title: i === 0 ? '咖啡机快照' : '背包快照', description: '完整物品快照描述', condition: 'GOOD', referenceValueFen: 2000, wantedText: '想换闲置物品', imageUrls: [1, 2, 3].map(image => `https://example.test/${image}.jpg`) })),
  parties: [10, 11].map((n, i) => ({ side: i === 0 ? 'INITIATOR' : 'RECIPIENT', userId: id(n), addressReady: i === 0, payments: [{ id: id(n + 30), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: i === 0 ? 'UNKNOWN' : 'PAID' }], outgoingShipment: null, handedOverAt: i === 0 ? '2026-10-03T01:00:00.000Z' : null, incomingDeliveredAt: null, acceptanceDeadline: '2026-10-06T01:00:00.000Z', acceptedAt: null })),
  cancellation: { id: id(50), requestedBySide: 'RECIPIENT', reason: '双方确认取消理由', status: 'REQUESTED', requestedAt: '2026-10-03T00:00:00.000Z', respondedAt: null },
  holdReason: '物流异常待处理', simulation: true, detailsDeadline: '2026-10-04T00:00:00.000Z', paymentDeadline: null, fulfillmentDeadline: '2026-10-06T00:00:00.000Z', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T01:00:00.000Z', ...patch,
});
function session() { window.sessionStorage.setItem('barter-admin-session', JSON.stringify({ accessToken: 'operator-token', expiresAt: Date.now() + 60000, user: { id: id(90), roles: ['OPERATIONS'] } })); }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true };
afterEach(() => { vi.unstubAllGlobals(); });

it('exposes authenticated order list/detail through the existing operator router', async () => {
  session(); window.history.replaceState({}, '', '/orders');
  const fetch = vi.fn(async (url: string) => url.endsWith('/admin/session') ? json({ id: id(90), roles: ['OPERATIONS'] }) : url.includes('/admin/items') ? json([]) : url.endsWith('/admin/orders') ? json({ items: [fixture()], nextCursor: null }) : json(fixture()));
  vi.stubGlobal('fetch', fetch); render(<AppRouter />);
  expect(await screen.findByRole('heading', { name: '订单查询' })).toBeVisible();
  expect(screen.getByRole('link', { name: '订单查询' })).toHaveAttribute('href', '/orders');
  fireEvent.click(await screen.findByRole('link', { name: `查看订单 ${id(1)}` }));
  expect(await screen.findByRole('heading', { name: '订单详情' })).toBeVisible();
});

it('protects order routes without a session', async () => {
  window.history.replaceState({}, '', `/orders/${id(1)}`); render(<AppRouter />);
  expect(await screen.findByRole('heading', { name: '运营审核登录' })).toBeVisible();
});

it('uses only GET for orders with encoded query and validates safe summaries', async () => {
  session(); const fetch = vi.fn().mockResolvedValueOnce(json({ items: [fixture()], nextCursor: null })).mockResolvedValueOnce(json(fixture()));
  const client = createApiClient({ fetchImpl: fetch });
  await client.listOrders({ status: 'ON_HOLD', cursor: 'a+b/c=', limit: 20 }); await client.getOrder(id(1));
  expect(fetch.mock.calls[0][0]).toBe('/api/admin/orders?status=ON_HOLD&cursor=a%2Bb%2Fc%3D&limit=20');
  expect(fetch.mock.calls[1][0]).toBe(`/api/admin/orders/${id(1)}`);
  for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer operator-token' }) });
  fetch.mockResolvedValueOnce(json({ ...fixture(), phone: '13900001234' }));
  await expect(client.getOrder(id(1))).rejects.toThrow();
});

it('renders desktop table and switches to 390px cards with long IDs', async () => {
  const client = { listOrders: vi.fn().mockResolvedValue({ items: [fixture()], nextCursor: null }), getOrder: vi.fn() };
  render(<MemoryRouter future={routerFuture}><OrderListPage client={client} /></MemoryRouter>);
  expect(await screen.findByRole('table', { name: '订单查询' })).toBeVisible();
  act(() => { window.innerWidth = 390; window.dispatchEvent(new Event('resize')); });
  expect(screen.getByRole('list', { name: '订单查询' })).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: `查看订单 ${id(1)}` })).toBeVisible();
  expect(screen.getByText('待处理 · v2')).toBeVisible();
});

it('filters exceptions, resets pagination, and discards a late old filter response', async () => {
  let resolveOld!: (value: unknown) => void;
  const client = { listOrders: vi.fn().mockResolvedValueOnce({ items: [fixture()], nextCursor: 'next-cursor' }).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce({ items: [fixture({ id: id(4), status: 'COMPLETED', holdReason: null })], nextCursor: null }).mockResolvedValueOnce({ items: [fixture()], nextCursor: null }), getOrder: vi.fn() };
  render(<MemoryRouter future={routerFuture}><OrderListPage client={client} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
  fireEvent.change(screen.getByLabelText('订单状态'), { target: { value: 'COMPLETED' } });
  expect(await screen.findByRole('link', { name: `查看订单 ${id(4)}` })).toBeVisible();
  await act(async () => { resolveOld({ items: [fixture({ id: id(5) })], nextCursor: null }); });
  expect(screen.queryByRole('link', { name: `查看订单 ${id(5)}` })).not.toBeInTheDocument();
  expect(client.listOrders.mock.calls).toEqual([[{}], [{ cursor: 'next-cursor' }], [{ status: 'COMPLETED' }]]);
  fireEvent.change(screen.getByLabelText('订单状态'), { target: { value: 'ON_HOLD' } });
  await waitFor(() => expect(client.listOrders).toHaveBeenLastCalledWith({ status: 'ON_HOLD' }));
});

it('shows loading, empty, failed pagination and retry without losing the loaded page', async () => {
  let resolve!: (value: unknown) => void;
  const client = { listOrders: vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce({ items: [fixture({ id: id(6) })], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null }), getOrder: vi.fn() };
  render(<MemoryRouter future={routerFuture}><OrderListPage client={client} /></MemoryRouter>);
  expect(screen.getByRole('status')).toHaveTextContent('加载订单中');
  await act(async () => { resolve({ items: [fixture()], nextCursor: 'next' }); });
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  expect(screen.getByRole('link', { name: `查看订单 ${id(1)}` })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('link', { name: `查看订单 ${id(6)}` })).toBeVisible();
  fireEvent.change(screen.getByLabelText('订单状态'), { target: { value: 'CANCELLED' } });
  expect(await screen.findByText('暂无订单')).toBeVisible();
});

it('shows both safe progress, money, hold and deadlines as read-only facts at 390px', async () => {
  window.innerWidth = 390;
  const order = fixture(); order.parties[1]!.outgoingShipment = { id: id(70), carrier: 'SF', trackingNumber: 'LONGTRACKINGNUMBER1234567890', status: 'REGISTERED', registeredAt: order.createdAt, collectedAt: null, deliveredAt: null };
  const client = { listOrders: vi.fn(), getOrder: vi.fn().mockResolvedValue(order) };
  render(<MemoryRouter future={routerFuture}><OrderDetailPage client={client} orderId={order.id} /></MemoryRouter>);
  expect(await screen.findByText('物流异常待处理')).toBeVisible();
  expect(screen.getByText('仅供查询，运营不能代替用户履约或处理资金')).toBeVisible();
  expect(screen.getByText('咖啡机快照')).toBeVisible(); expect(screen.getByText('背包快照')).toBeVisible();
  expect(screen.getByText('差价：¥5.00 · 发起方补差')).toBeVisible();
  expect(screen.getByText('UNKNOWN · ¥10.00')).toBeVisible(); expect(screen.getByText('PAID · ¥10.00')).toBeVisible();
  expect(screen.getByText('已登记（尚未确认揽收）')).toBeVisible();
  expect(screen.getByText('面交交出：2026-10-03 01:00:00 UTC')).toBeVisible();
  expect(screen.getByText('资料截止：2026-10-04 00:00:00 UTC')).toBeVisible();
  expect(screen.getByText('期限仅展示，查询不会推进订单状态')).toBeVisible();
  expect(screen.queryByRole('button', { name: /付款|验收|取消|退款|完成|改状态|导出/ })).not.toBeInTheDocument();
});

it('discards late detail reads across resource changes and unmount', async () => {
  let resolve!: (value: OrderView) => void;
  const client = { listOrders: vi.fn(), getOrder: vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(fixture({ id: id(8), holdReason: '新订单异常' })) };
  const view = render(<MemoryRouter future={routerFuture}><OrderDetailPage client={client} orderId={id(1)} /></MemoryRouter>);
  view.rerender(<MemoryRouter future={routerFuture}><OrderDetailPage client={client} orderId={id(8)} /></MemoryRouter>);
  expect(await screen.findByText('新订单异常')).toBeVisible();
  await act(async () => { resolve(fixture()); });
  expect(screen.queryByText('物流异常待处理')).not.toBeInTheDocument();
  view.unmount();
});

it('shows unknown detail error and retries the same read', async () => {
  const client = { listOrders: vi.fn(), getOrder: vi.fn().mockRejectedValueOnce(new Error('订单不存在')).mockResolvedValueOnce(fixture()) };
  render(<MemoryRouter future={routerFuture}><OrderDetailPage client={client} orderId={id(1)} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('订单不存在'); fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('物流异常待处理')).toBeVisible(); expect(client.getOrder.mock.calls).toEqual([[id(1)], [id(1)]]);
});
