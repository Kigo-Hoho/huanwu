import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedApiClient } from '../../lib/api-client';
import { Session } from '../auth/session';
import { OrderApi } from './order-api';
import { orderFixture, orderId as id } from '../../test/order-fixtures';
const order = orderFixture();
const address = { expectedVersion: 1, recipientName: '测试甲', phone: '13800000000', region: '测试市', detail: '测试街道一号' };
function harness() {
  const stored = new Map<string, unknown>();
  const storage = { getStorageSync: (key: string) => stored.get(key), setStorageSync: (key: string, value: unknown) => { stored.set(key, value); }, removeStorageSync: (key: string) => { stored.delete(key); } };
  const session = new Session(storage); session.setAccessToken('token', 900);
  const request = vi.fn().mockResolvedValue({ statusCode: 200, data: { order } });
  const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
  return { api: new OrderApi(client), request, client, stored };
}

describe('order transport and logical commands', () => {
  it('maps every customer action with a canonical body and its logical key', async () => {
    const { api, request } = harness();
    const cases = [
      ['convert', '/api/proposals/' + id(5) + '/order', { expectedVersion: 1 }],
      ['address', '/api/orders/' + order.id + '/address', address],
      ['payment', '/api/orders/' + order.id + '/payments', { expectedVersion: 1, purpose: 'DEPOSIT' }],
      ['shipment', '/api/orders/' + order.id + '/shipments', { expectedVersion: 1, carrier: ' sf ', trackingNumber: ' track123 ' }],
      ['handover', '/api/orders/' + order.id + '/handover', { expectedVersion: 1 }],
      ['acceptance', '/api/orders/' + order.id + '/acceptance', { expectedVersion: 1 }],
      ['issue', '/api/orders/' + order.id + '/issue', { expectedVersion: 1, reason: '物品存在异议' }],
      ['cancellation', '/api/orders/' + order.id + '/cancellation', { expectedVersion: 1, reason: '无法完成交换' }],
      ['respondCancellation', '/api/orders/' + order.id + '/cancellation/respond', { expectedVersion: 1, cancellationId: id(30), decision: 'AGREE' }],
      ['withdrawCancellation', '/api/orders/' + order.id + '/cancellation/withdraw', { expectedVersion: 1, cancellationId: id(30) }],
    ] as const;
    for (const [action, path, input] of cases) {
      await api.runLogicalCommand(action === 'convert' ? id(5) : order.id, action, input);
      expect(request.mock.lastCall![0]).toMatchObject({ url: 'http://localhost:3000' + path, method: 'POST', data: action === 'shipment' ? { expectedVersion: 1, carrier: 'SF', trackingNumber: 'TRACK123' } : input, header: { Authorization: 'Bearer token', 'Idempotency-Key': expect.any(String) } });
    }
  });
  it.each([new Error('offline'), { statusCode: 503, data: { message: 'Unavailable' } }])('reuses the original body and key after uncertain results %s', async failure => {
    const { api, request } = harness();
    if (failure instanceof Error) request.mockRejectedValueOnce(failure); else request.mockResolvedValueOnce(failure);
    await expect(api.saveAddress(order.id, address)).rejects.toThrow();
    await expect(api.saveAddress(order.id, { ...address, phone: '13900000000' })).rejects.toMatchObject({ message: expect.stringContaining('结果未明') });
    await api.saveAddress(order.id, address);
    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[1]![0].data).toEqual(address);
    expect(request.mock.calls[1]![0].header['Idempotency-Key']).toBe(request.mock.calls[0]![0].header['Idempotency-Key']);
  });
  it('coalesces concurrent clicks before the network completes', async () => {
    const { api, request } = harness();
    let resolve!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const a = api.acceptOrder(order.id, { expectedVersion: 1 });
    const b = api.acceptOrder(order.id, { expectedVersion: 1 });
    expect(request).toHaveBeenCalledTimes(1);
    resolve({ statusCode: 200, data: { order } }); await Promise.all([a, b]);
  });
  it('uses a fresh key after a deterministic conflict and explicit reconfirmation', async () => {
    const { api, request } = harness();
    request.mockResolvedValueOnce({ statusCode: 409, data: { message: 'Expired', code: 'ORDER_EXPIRED' } });
    await expect(api.acceptOrder(order.id, { expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 409 });
    await api.acceptOrder(order.id, { expectedVersion: 2 });
    expect(request.mock.calls[1]![0].header['Idempotency-Key']).not.toBe(request.mock.calls[0]![0].header['Idempotency-Key']);
  });
  it('retries a 401 through existing authentication with exactly the same key and body', async () => {
    const { api, request, client } = harness(); await client.authenticate({ getCode: async () => 'code' });
    request.mockResolvedValueOnce({ statusCode: 401, data: {} }).mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'fresh', expiresIn: 900 } });
    await api.startPayment(order.id, { expectedVersion: 1, purpose: 'DEPOSIT' });
    expect(request.mock.calls[2]![0]).toMatchObject({ data: request.mock.calls[0]![0].data, header: { Authorization: 'Bearer fresh', 'Idempotency-Key': request.mock.calls[0]![0].header['Idempotency-Key'] } });
  });
  it('rejects extra command fields, invalid resources and sensitive summary responses', async () => {
    const { api, request } = harness();
    await expect(api.runLogicalCommand(order.id, 'payment', { expectedVersion: 1, purpose: 'DEPOSIT', amountFen: 1 })).rejects.toThrow();
    await expect(api.acceptOrder('x/../../admin', { expectedVersion: 1 })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ statusCode: 200, data: { ...order, phone: '13800000000' } });
    await expect(api.getOrder(order.id)).rejects.toThrow();
  });
  it('reads private address and checkout only through their authorized GETs without persisting private fields', async () => {
    const { api, request, stored } = harness();
    request.mockResolvedValueOnce({ statusCode: 200, data: { orderId: order.id, side: 'RECIPIENT', version: 1, recipientName: address.recipientName, phone: address.phone, region: address.region, detail: address.detail } });
    expect((await api.getShippingAddress(order.id, 'outgoing')).phone).toBe('13800000000');
    expect(request.mock.lastCall![0].url).toBe('http://localhost:3000/api/orders/' + order.id + '/shipping-address?side=outgoing');
    request.mockResolvedValueOnce({ statusCode: 200, data: { status: 'PENDING', paymentIntentId: id(40) } });
    expect((await api.getCheckout(order.id, id(40))).status).toBe('PENDING');
    expect(request.mock.lastCall![0].url).toBe('http://localhost:3000/api/orders/' + order.id + '/payments/' + id(40) + '/checkout');
    await api.saveAddress(order.id, address);
    expect(JSON.stringify([...stored.values()])).not.toMatch(/13800000000|测试街道|recipientName/);
  });
  it('never carries a previous customer address command into another customer identity', async () => {
    const { api, request } = harness();
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(10), roles: ['CUSTOMER'] } }); await api.getMe();
    request.mockRejectedValueOnce(new Error('unknown')); await expect(api.saveAddress(order.id, address)).rejects.toThrow();
    expect(api.getPendingCommand(order.id, id(10))).toEqual({ resourceId: order.id, action: 'address' });
    expect(api.getPendingCommand(id(21), id(10))).toBeNull(); expect(api.getPendingCommand(order.id, id(11))).toBeNull();
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(11), roles: ['CUSTOMER'] } }); await api.getMe();
    expect(api.getPendingCommand(order.id, id(11))).toBeNull();
    await api.saveAddress(order.id, { ...address, recipientName: '测试乙' });
    expect(request.mock.lastCall![0].data.recipientName).toBe('测试乙');
    expect(request.mock.lastCall![0].header['Idempotency-Key']).not.toBe(request.mock.calls[1]![0].header['Idempotency-Key']);
    expect(api.getPendingCommand(order.id, id(11))).toBeNull();
  });
  it('retains the same key after malformed success until a valid summary resolves the attempt', async () => {
    const { api, request } = harness(); request.mockResolvedValueOnce({ statusCode: 200, data: { order: { ...order, phone: 'private' } } });
    await expect(api.acceptOrder(order.id, { expectedVersion: 1 })).rejects.toThrow();
    await api.acceptOrder(order.id, { expectedVersion: 1 });
    expect(request.mock.calls[1]![0].header['Idempotency-Key']).toBe(request.mock.calls[0]![0].header['Idempotency-Key']);
  });
  it('does not let an older identity response erase the current customer unknown command', async () => {
    const { api, request } = harness();
    let finishA!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise(resolve => { finishA = resolve; }));
    const staleA = api.getMe().catch(() => undefined);
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(11), roles: ['CUSTOMER'] } });
    await api.getMe();
    request.mockRejectedValueOnce(new Error('unknown B outcome'));
    await expect(api.saveAddress(order.id, address)).rejects.toThrow();
    finishA({ statusCode: 200, data: { id: id(10), roles: ['CUSTOMER'] } }); expect(await staleA).toBeUndefined();
    await api.saveAddress(order.id, address);
    const posts = request.mock.calls.map(call => call[0]).filter(options => options.method === 'POST');
    expect(posts).toHaveLength(2); expect(posts[1].data).toEqual(address);
    expect(posts[1].header['Idempotency-Key']).toBe(posts[0].header['Idempotency-Key']);
  });
});
