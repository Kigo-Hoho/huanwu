import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MyItemsPage } from '../items/mine/index';
import { OrderDetailPage } from './detail/index';
import { OrderListPage } from './list/index';
import { OrderApi } from '../../features/orders/order-api';
import { AuthenticatedApiClient, type RequestPort } from '../../lib/api-client';
import { Session } from '../../features/auth/session';
import { orderFixture, orderId as id } from '../../test/order-fixtures';
import type { OrderView, Role } from '@barter/contracts';

function harness(initial = orderFixture(), roles: Role[] = ['CUSTOMER'], actor = id(10)) {
  let order = initial;
  let currentActor = actor;
  const calls: Parameters<RequestPort>[0][] = [];
  const stored = new Map<string, unknown>();
  const session = new Session({ getStorageSync: key => stored.get(key), setStorageSync: (key, value) => { stored.set(key, value); }, removeStorageSync: key => { stored.delete(key); } });
  session.setAccessToken('token', 900);
  const request = vi.fn<RequestPort>(async options => {
    calls.push(options);
    if (options.url.endsWith('/api/me')) return { statusCode: 200, data: { id: currentActor, roles } };
    if (options.url.endsWith('/api/me/orders')) return { statusCode: 200, data: { items: [order], nextCursor: null } };
    return { statusCode: 200, data: options.method === 'POST' ? { order } : order };
  });
  return { api: new OrderApi(new AuthenticatedApiClient('http://localhost:3000', session, request)), request, calls, stored, setOrder: (value: OrderView) => { order = value; }, setActor: (value: string) => { currentActor = value; } };
}
function simulationBuild() {
  vi.stubGlobal('__INTEGRATION_MODE__', 'simulated'); vi.stubGlobal('__BUILD_ENVIRONMENT__', 'acceptance');
  vi.stubGlobal('__TARO_TARGET__', 'h5'); vi.stubGlobal('__IDENTITY_PROVIDER__', 'acceptance');
}

describe('customer order entry', () => {
  // Removing the real mine entry strands confirmed customers outside the order flow.
  it('opens my orders from the existing mine workbench', async () => {
    const navigate = vi.fn();
    render(<MyItemsPage api={{ listMyItems: vi.fn().mockResolvedValue([]) }} navigateToDetail={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: '我的订单' }));
    expect(navigate).toHaveBeenCalledWith('/pages/orders/list/index');
  });
  it('shows a customer list and navigates to the actual selected order', async () => {
    const h = harness(); const navigate = vi.fn(); render(<OrderListPage api={h.api} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: '查看订单 ' + id(20) }));
    expect(navigate).toHaveBeenCalledWith('/pages/orders/detail/index?id=' + id(20));
  });
  it('renders both sides, immutable terms, deadline and own address form without counterparty actions', async () => {
    const h = harness(); render(<OrderDetailPage api={h.api} orderId={id(20)} />);
    expect(await screen.findByText('测试支付／测试物流，不产生真实资金或寄递')).toBeVisible();
    expect(screen.getByText('发起方：家用咖啡机')).toBeVisible(); expect(screen.getByText('接收方：户外背包')).toBeVisible();
    expect(screen.getByText('差价：￥5.00 · 发起方补差')).toBeVisible();
    expect(screen.getByText('资料截止：2099-10-08T00:00:00.000Z')).toBeVisible();
    expect(screen.getByLabelText('收件人')).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认对方收货' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发起保证金付款' })).not.toBeInTheDocument();
  });
  it.each([{ roles: ['CUSTOMER', 'REVIEWER'] as Role[] }, { roles: ['OPERATIONS'] as Role[] }])('hides customer commands for non-pure customer roles $roles', async ({ roles }) => {
    const h = harness(orderFixture(), roles); render(<OrderDetailPage api={h.api} orderId={id(20)} />);
    await screen.findByText('待双方资料'); expect(screen.queryByLabelText('收件人')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '申请取消订单' })).not.toBeInTheDocument();
  });
  it('shows payment pending from API and own test action only under both simulation gates', async () => {
    simulationBuild();
    try {
      const order = orderFixture({ status: 'AWAITING_PAYMENT', detailsDeadline: null, paymentDeadline: '2099-10-08T00:00:00.000Z' });
      order.parties[0]!.payments = [{ id: id(40), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' }];
      order.parties[1]!.payments = [{ id: id(41), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' }];
      const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
      expect(await screen.findByRole('button', { name: '完成测试保证金付款' })).toBeVisible();
      expect(screen.getAllByRole('button', { name: /完成测试/ })).toHaveLength(1);
      h.request.mockImplementationOnce(async options => { h.calls.push(options); return { statusCode: 200, data: { status: 'PENDING', paymentIntentId: id(40) } }; });
      fireEvent.click(screen.getByRole('button', { name: '查询保证金付款参数' }));
      expect(await screen.findByText('付款参数准备中，资金状态以订单刷新为准')).toBeVisible();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([false, true])('does not expose test drivers when either API simulation or build gate is off: %s', async simulation => {
    const order = orderFixture({ simulation, status: 'AWAITING_PAYMENT' });
    order.parties[0]!.payments = [{ id: id(40), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' }];
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    await screen.findByText('待双方付款'); expect(screen.queryByRole('button', { name: /完成测试/ })).not.toBeInTheDocument();
  });
  it('allows only own outgoing courier submission and own incoming acceptance', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', detailsDeadline: null, fulfillmentDeadline: '2099-10-10T00:00:00.000Z' });
    order.parties[0]!.incomingDeliveredAt = '2026-10-07T00:00:00.000Z'; order.parties[0]!.acceptanceDeadline = '2099-10-10T00:00:00.000Z';
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    expect(await screen.findByRole('button', { name: '登记我的运单' })).toBeVisible();
    expect(screen.getByRole('button', { name: '验收我的来件' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认我已交出物品' })).not.toBeInTheDocument();
  });
  it('uses explicit own handover without a courier form for face-to-face orders', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    fireEvent.click(await screen.findByRole('button', { name: '确认我已交出物品' }));
    await waitFor(() => expect(h.calls.some(c => c.method === 'POST' && c.url.endsWith('/handover'))).toBe(true));
    expect(screen.queryByLabelText('运单号')).not.toBeInTheDocument();
  });
  it('renders persisted single-side handover after reload and hides duplicate handover and cancellation', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    order.parties[0]!.handedOverAt = '2026-10-07T00:00:00.000Z';
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    expect(await screen.findByText('发起方面交交出：2026-10-07T00:00:00.000Z')).toBeVisible();
    expect(screen.getByText('接收方面交交出：尚未交出')).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认我已交出物品' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '申请取消订单' })).not.toBeInTheDocument();
  });
  it('treats absent legacy handover fields as unknown until a fresh view supplies persisted progress', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    delete order.parties[0]!.handedOverAt; delete order.parties[1]!.handedOverAt;
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    await screen.findByText('订单版本：1');
    expect(screen.queryByRole('button', { name: '确认我已交出物品' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '申请取消订单' })).not.toBeInTheDocument();
  });
  it('blocks fulfillment while cancellation is unresolved and offers only the other side response', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', cancellation: { id: id(30), requestedBySide: 'RECIPIENT', reason: '无法继续交换', status: 'REQUESTED', requestedAt: '2026-10-07T00:00:00.000Z', respondedAt: null } });
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    expect(await screen.findByRole('button', { name: '同意取消订单' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '登记我的运单' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤回取消请求' })).not.toBeInTheDocument();
  });
  it.each(['ON_HOLD', 'CANCEL_PENDING', 'SETTLING', 'COMPLETED', 'CANCELLED'] as const)('keeps %s read-only with no resume/unlock or refund controls', async status => {
    const h = harness(orderFixture({ status, holdReason: status === 'ON_HOLD' ? '物流异常' : null })); render(<OrderDetailPage api={h.api} orderId={id(20)} />);
    await screen.findByText('订单版本：1');
    expect(screen.queryByRole('button', { name: /申请取消|登记我的运单|验收我的来件|恢复|解锁|退款|完成测试/ })).not.toBeInTheDocument();
  });
  it.each([403, 409])('refreshes persisted state after %s and requires a new explicit click', async statusCode => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />);
    await screen.findByRole('button', { name: '确认我已交出物品' });
    h.request.mockImplementationOnce(async options => { h.calls.push(options); return { statusCode, data: { message: '订单已更新', code: 'ORDER_EXPIRED' } }; });
    h.setOrder({ ...order, version: 2 }); fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' }));
    await screen.findByText('订单版本：2'); expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(screen.getByText('订单已更新，请核对后重新确认操作')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' }));
    await waitFor(() => expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(2));
    expect(h.calls.filter(c => c.method === 'POST')[1]!.data).toEqual({ expectedVersion: 2 });
  });
  it('rejects a slow old read and a historical successful replay without regressing the displayed version', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByText('订单版本：1');
    let resolve!: (value: { statusCode: number; data: OrderView }) => void;
    h.request.mockImplementationOnce(options => { h.calls.push(options); return new Promise(r => { resolve = r; }); });
    fireEvent.click(screen.getByRole('button', { name: '刷新订单' }));
    h.request.mockImplementationOnce(async options => { h.calls.push(options); return { statusCode: 200, data: { order: { ...order, version: 3 } } }; });
    fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' })); await screen.findByText('订单版本：3');
    await act(async () => { resolve({ statusCode: 200, data: order }); }); expect(screen.getByText('订单版本：3')).toBeVisible();
    h.request.mockImplementationOnce(async options => { h.calls.push(options); return { statusCode: 200, data: { order: { ...order, version: 2 } } }; });
    h.setOrder({ ...order, version: 4 }); fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' }));
    expect(await screen.findByText('订单版本：4')).toBeVisible();
  });
  it('retries the original unknown command even when a newer read hides its normal action', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByRole('button', { name: '确认我已交出物品' });
    h.request.mockImplementationOnce(async options => { h.calls.push(options); throw new Error('network unknown'); });
    fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' })); await screen.findByRole('button', { name: '重试原操作' });
    const newer = { ...order, version: 4, parties: order.parties.map(p => ({ ...p, handedOverAt: '2026-10-07T00:00:00.000Z' })) }; h.setOrder(newer);
    fireEvent.click(screen.getByRole('button', { name: '刷新订单' })); await screen.findByText('订单版本：4');
    expect(screen.queryByRole('button', { name: '确认我已交出物品' })).not.toBeInTheDocument();
    h.request.mockImplementationOnce(async options => { h.calls.push(options); const legacy = { ...order, version: 2, parties: order.parties.map(p => { const old = { ...p }; delete old.handedOverAt; return old; }) }; return { statusCode: 200, data: { order: legacy } }; });
    fireEvent.click(screen.getByRole('button', { name: '重试原操作' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试原操作' })).not.toBeInTheDocument());
    const posts = h.calls.filter(c => c.method === 'POST'); expect(posts).toHaveLength(2);
    expect(posts[1]!.data).toEqual({ expectedVersion: 1 }); expect(posts[1]!.header!['Idempotency-Key']).toBe(posts[0]!.header!['Idempotency-Key']);
    expect(screen.getByText('订单版本：4')).toBeVisible();
  });
  it('does not apply an old command after navigating to another order', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    const h = harness(order); const page = render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByRole('button', { name: '确认我已交出物品' });
    let resolve!: (value: { statusCode: number; data: unknown }) => void;
    h.request.mockImplementationOnce(options => { h.calls.push(options); return new Promise(r => { resolve = r; }); });
    fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' }));
    const second = orderFixture({ id: id(21) }); h.setOrder(second); page.rerender(<OrderDetailPage api={h.api} orderId={second.id} />);
    await screen.findByText('订单号：' + second.id);
    await act(async () => { resolve({ statusCode: 200, data: { order: { ...order, version: 8 } } }); });
    expect(screen.getByText('订单号：' + second.id)).toBeVisible(); expect(screen.queryByText('订单号：' + order.id)).not.toBeInTheDocument();
  });
  it('recovers the original unknown handover after remount on the same API and a newer order', async () => {
    const order = orderFixture({ status: 'AWAITING_FULFILLMENT', terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    const h = harness(order); const first = render(<OrderDetailPage api={h.api} orderId={order.id} />);
    await screen.findByRole('button', { name: '确认我已交出物品' });
    h.request.mockImplementationOnce(async options => { h.calls.push(options); throw new Error('unknown'); });
    fireEvent.click(screen.getByRole('button', { name: '确认我已交出物品' })); await screen.findByRole('button', { name: '重试原操作' }); first.unmount();
    h.setOrder({ ...order, version: 2, parties: order.parties.map(p => ({ ...p, handedOverAt: '2026-10-07T00:00:00.000Z' })) });
    render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByText('订单版本：2');
    expect(screen.queryByRole('button', { name: '确认我已交出物品' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '重试原操作' }));
    await waitFor(() => expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(2));
    const posts = h.calls.filter(c => c.method === 'POST'); expect(posts[1]!.data).toEqual({ expectedVersion: 1 });
    expect(posts[1]!.header!['Idempotency-Key']).toBe(posts[0]!.header!['Idempotency-Key']);
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试原操作' })).not.toBeInTheDocument());
  });
  it('recovers unknown address plaintext only from RAM after remount without re-entering it', async () => {
    const h = harness(); const first = render(<OrderDetailPage api={h.api} orderId={id(20)} />);
    await screen.findByLabelText('收件人');
    for (const [label, value] of [['收件人', '测试甲'], ['电话', '13811112222'], ['地区', '测试地区'], ['详细地址', '私人测试街道一号']]) fireEvent.input(screen.getByLabelText(label!), { target: { value } });
    h.request.mockImplementationOnce(async options => { h.calls.push(options); throw new Error('unknown address'); });
    fireEvent.click(screen.getByRole('button', { name: '保存我的收货资料' })); await screen.findByRole('button', { name: '重试原操作' }); first.unmount();
    h.setOrder(orderFixture({ version: 2 })); render(<OrderDetailPage api={h.api} orderId={id(20)} />); await screen.findByText('订单版本：2');
    fireEvent.click(await screen.findByRole('button', { name: '重试原操作' }));
    await waitFor(() => expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(2));
    const posts = h.calls.filter(c => c.method === 'POST');
    expect(posts[1]!.data).toEqual({ expectedVersion: 1, recipientName: '测试甲', phone: '13811112222', region: '测试地区', detail: '私人测试街道一号' });
    expect(posts[1]!.header!['Idempotency-Key']).toBe(posts[0]!.header!['Idempotency-Key']);
    expect(JSON.stringify([...h.stored.values()])).not.toContain('私人测试街道');
  });
  it('clears every private address draft on same-order same-version participant change', async () => {
    const h = harness(); render(<OrderDetailPage api={h.api} orderId={id(20)} />); await screen.findByLabelText('收件人');
    for (const [label, value] of [['收件人', '测试甲'], ['电话', '13811112222'], ['地区', '测试地区'], ['详细地址', '私人测试街道一号'], ['操作原因', '甲的取消原因']]) fireEvent.input(screen.getByLabelText(label!), { target: { value } });
    h.setActor(id(11)); fireEvent.click(screen.getByRole('button', { name: '刷新订单' })); await screen.findByText('接收方（我）进度');
    for (const label of ['收件人', '电话', '地区', '详细地址', '操作原因']) expect(screen.getByLabelText(label)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '保存我的收货资料' })); expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
  it('clears courier drafts and reason on same-version participant change', async () => {
    const h = harness(orderFixture({ status: 'AWAITING_FULFILLMENT' })); render(<OrderDetailPage api={h.api} orderId={id(20)} />); await screen.findByLabelText('承运人');
    for (const [label, value] of [['承运人', 'SF'], ['运单号', 'TRACKA123'], ['操作原因', '甲的取消原因']]) fireEvent.input(screen.getByLabelText(label!), { target: { value } });
    h.setActor(id(11)); fireEvent.click(screen.getByRole('button', { name: '刷新订单' })); await screen.findByText('接收方（我）进度');
    for (const label of ['承运人', '运单号', '操作原因']) expect(screen.getByLabelText(label)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '登记我的运单' })); expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
  it('invalidates a prior participant checkout callback at the actor boundary', async () => {
    const order = orderFixture({ status: 'AWAITING_PAYMENT' });
    order.parties[0]!.payments = [{ id: id(40), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' }];
    order.parties[1]!.payments = [{ id: id(41), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' }];
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByRole('button', { name: '查询保证金付款参数' });
    let finish!: (value: { statusCode: number; data: unknown }) => void;
    h.request.mockImplementationOnce(options => { h.calls.push(options); return new Promise(resolve => { finish = resolve; }); });
    fireEvent.click(screen.getByRole('button', { name: '查询保证金付款参数' })); h.setActor(id(11));
    fireEvent.click(screen.getByRole('button', { name: '刷新订单' })); await screen.findByText('接收方（我）进度');
    await act(async () => { finish({ statusCode: 200, data: { status: 'PENDING', paymentIntentId: id(40) } }); });
    expect(screen.queryByText('付款参数准备中，资金状态以订单刷新为准')).not.toBeInTheDocument();
  });
  it('restores a testing intent only for its owning order and keeps the original key', async () => {
    simulationBuild();
    try {
      const order = orderFixture({ status: 'AWAITING_PAYMENT' });
      order.parties[0]!.payments = [{ id: id(40), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' }];
      const h = harness(order); const first = render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByRole('button', { name: '完成测试保证金付款' });
      h.request.mockImplementationOnce(async options => { h.calls.push(options); throw new Error('unknown intent'); });
      fireEvent.click(screen.getByRole('button', { name: '完成测试保证金付款' })); await screen.findByRole('button', { name: '重试原操作' }); first.unmount();
      const other = orderFixture({ id: id(21) }); h.setOrder(other); const second = render(<OrderDetailPage api={h.api} orderId={other.id} />); await screen.findByText('订单号：' + other.id);
      expect(screen.queryByRole('button', { name: '重试原操作' })).not.toBeInTheDocument(); second.unmount();
      h.setOrder({ ...order, version: 2 }); render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByText('订单版本：2');
      fireEvent.click(await screen.findByRole('button', { name: '重试原操作' }));
      await waitFor(() => expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(2));
      const posts = h.calls.filter(c => c.method === 'POST');
      expect(posts[1]!.url).toBe('http://localhost:3000/api/testing/payments/' + id(40) + '/complete');
      expect(posts[1]!.data).toEqual({ expectedVersion: 1 }); expect(posts[1]!.header!['Idempotency-Key']).toBe(posts[0]!.header!['Idempotency-Key']);
    } finally { vi.unstubAllGlobals(); }
  });
  it('discards an old private read begun during a same-version identity refresh', async () => {
    const order = orderFixture(); order.parties[0]!.addressReady = true;
    const h = harness(order); render(<OrderDetailPage api={h.api} orderId={order.id} />); await screen.findByRole('button', { name: '查看我的收货资料' });
    let finishIdentity!: (value: { statusCode: number; data: unknown }) => void;
    let finishAddress!: (value: { statusCode: number; data: unknown }) => void;
    h.request.mockImplementationOnce(async options => { h.calls.push(options); return { statusCode: 200, data: order }; });
    h.request.mockImplementationOnce(options => { h.calls.push(options); return new Promise(resolve => { finishIdentity = resolve; }); });
    fireEvent.click(screen.getByRole('button', { name: '刷新订单' }));
    h.request.mockImplementationOnce(options => { h.calls.push(options); return new Promise(resolve => { finishAddress = resolve; }); });
    fireEvent.click(screen.getByRole('button', { name: '查看我的收货资料' }));
    await act(async () => { finishIdentity({ statusCode: 200, data: { id: id(11), roles: ['CUSTOMER'] } }); }); await screen.findByText('接收方（我）进度');
    await act(async () => { finishAddress({ statusCode: 200, data: { orderId: order.id, side: 'INITIATOR', version: 1, recipientName: '旧甲资料', phone: '13811112222', region: '测试地区', detail: '旧甲私人地址' } }); });
    expect(screen.queryByText(/旧甲私人地址/)).not.toBeInTheDocument();
  });
});
