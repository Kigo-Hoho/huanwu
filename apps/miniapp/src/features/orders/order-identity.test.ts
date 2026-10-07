import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedApiClient, type RequestPort } from '../../lib/api-client';
import { Session } from '../auth/session';
import { OrderApi } from './order-api';
import { orderFixture, orderId } from '../../test/order-fixtures';

const order = orderFixture();
const actor = (n: number) => ({ id: orderId(n), roles: ['CUSTOMER'] });
const input = { expectedVersion: 1, recipientName: '甲的私有姓名', phone: '13800000000', region: '测试市', detail: '甲的私有地址' };
const privateView = { ...input, expectedVersion: undefined, orderId: order.id, side: 'INITIATOR', version: 1 };
delete privateView.expectedVersion;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function restoredHarness() {
  let now = 0;
  const stored = new Map<string, unknown>([['barter.customer.accessToken', { accessToken: 'restored-A', expiresAt: 900000 }]]);
  const session = new Session({ getStorageSync: k => stored.get(k), setStorageSync: (k, v) => { stored.set(k, v); }, removeStorageSync: k => { stored.delete(k); } }, () => now);
  const request = vi.fn<RequestPort>().mockResolvedValue({ statusCode: 200, data: { order } });
  const client = new AuthenticatedApiClient('http://localhost', session, request);
  return { session, stored, request, client, api: new OrderApi(client), expire: () => { now = 901000; } };
}
async function harness() {
  let now = 0;
  const stored = new Map<string, unknown>();
  const session = new Session({ getStorageSync: k => stored.get(k), setStorageSync: (k, v) => { stored.set(k, v); }, removeStorageSync: k => { stored.delete(k); } }, () => now);
  const request = vi.fn<RequestPort>().mockResolvedValue({ statusCode: 200, data: { order } });
  request.mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'A', expiresIn: 900, user: actor(10) } });
  const client = new AuthenticatedApiClient('http://localhost', session, request); const api = new OrderApi(client);
  await api.authenticate({ getCode: async () => 'code' });
  request.mockResolvedValueOnce({ statusCode: 200, data: actor(10) }); await api.getMe(); request.mockClear();
  return { api, client, request, session, stored, expire: () => { now = 901000; } };
}

describe('initiating order identity boundary', () => {
  it.each(['address', 'self', 'outgoing'] as const)('rejects restored stale A proof before it can authorize %s with replacement B', async operation => {
    const h = restoredHarness(); const late = deferred<Awaited<ReturnType<RequestPort>>>();
    const starting = h.session.getIdentity(); expect(starting.actorId).toBeNull();
    h.request.mockReturnValueOnce(late.promise);
    const identity = h.api.getMe().then(value => ({ value }), error => ({ error }));
    expect(h.request.mock.calls[0][0].header?.Authorization).toBe('Bearer restored-A');
    h.stored.set('barter.customer.accessToken', { accessToken: 'external-B', expiresAt: 900000 });
    expect(h.session.getIdentity()).toMatchObject({ actorId: null, epoch: starting.epoch });
    late.resolve({ statusCode: 200, data: actor(10) });
    const proof = await identity;
    h.request.mockResolvedValue({ statusCode: 200, data: operation === 'address' ? { order } : privateView });
    const result = await (operation === 'address' ? h.api.saveAddress(order.id, input) : h.api.getShippingAddress(order.id, operation))
      .then(value => ({ value }), error => ({ error }));
    expect.soft(proof).toMatchObject({ error: { name: 'OrderIdentityChangedError' } });
    expect.soft(result).toMatchObject({ error: { name: 'OrderIdentityChangedError' } });
    expect.soft(h.session.getIdentity().actorId).toBeNull();
    expect(h.request.mock.calls.filter(([o]) => o.url.includes('/api/orders/'))).toHaveLength(0);
    expect(h.api.getPendingCommand(order.id, orderId(10))).toBeNull();
  });
  it('admits initial restored identity proof from its unchanged credential', async () => {
    const h = restoredHarness(); h.request.mockResolvedValueOnce({ statusCode: 200, data: actor(10) });
    await expect(h.api.getMe()).resolves.toEqual(actor(10));
    await expect(h.api.saveAddress(order.id, input)).resolves.toEqual({ order });
    expect(h.request.mock.calls[1][0].header?.Authorization).toBe('Bearer restored-A');
  });
  it.each(['valid', 'invalid'] as const)('leaves newer explicit B identity intact when late A proof is %s', async shape => {
    const h = restoredHarness(); const late = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockReturnValueOnce(late.promise); const identity = h.api.getMe().catch(error => error);
    h.session.setAccessToken('explicit-B', 900, orderId(11));
    late.resolve({ statusCode: 200, data: shape === 'valid' ? actor(10) : {} });
    expect(await identity).toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.session.getIdentity().actorId).toBe(orderId(11));
    expect(h.session.getAccessToken()).toBe('explicit-B');
  });
  it('rejects late proof after an unobserved storage replacement', async () => {
    const h = restoredHarness(); const late = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockReturnValueOnce(late.promise); const identity = h.api.getMe().catch(error => error);
    h.stored.set('barter.customer.accessToken', { accessToken: 'unobserved-B', expiresAt: 900000 });
    late.resolve({ statusCode: 200, data: actor(10) });
    expect(await identity).toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.session.getIdentity().actorId).toBeNull();
  });
  it.each(['no-expiry', 'before-refresh', 'during-refresh'] as const)('uses the actual same-A replay credential for restored getMe proof with %s', async timing => {
    const h = restoredHarness(); const auth = deferred<Awaited<ReturnType<RequestPort>>>();
    await h.api.authenticate({ getCode: async () => 'A' });
    h.request.mockImplementationOnce(async () => { if (timing === 'before-refresh') h.expire(); return { statusCode: 401, data: {} }; })
      .mockReturnValueOnce(auth.promise).mockResolvedValueOnce({ statusCode: 200, data: actor(10) });
    const identity = h.api.getMe();
    await vi.waitFor(() => expect(h.request.mock.calls.some(([o]) => o.url.endsWith('/auth/wechat'))).toBe(true));
    if (timing === 'during-refresh') h.expire();
    auth.resolve({ statusCode: 201, data: { accessToken: 'actual-A-replay', expiresIn: 900, user: actor(10) } });
    await expect(identity).resolves.toEqual(actor(10));
    expect(h.request.mock.calls.filter(([o]) => o.url.endsWith('/api/me')).map(([o]) => o.header?.Authorization))
      .toEqual(['Bearer restored-A', 'Bearer actual-A-replay']);
    await expect(h.api.saveAddress(order.id, input)).resolves.toEqual({ order });
  });
  it('rejects proof if the successful replay credential is replaced while getMe awaits', async () => {
    const h = restoredHarness(); const replay = deferred<Awaited<ReturnType<RequestPort>>>();
    await h.api.authenticate({ getCode: async () => 'A' });
    h.request.mockResolvedValueOnce({ statusCode: 401, data: {} })
      .mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'actual-A-replay', expiresIn: 900 } }).mockReturnValueOnce(replay.promise);
    const identity = h.api.getMe().catch(error => error);
    await vi.waitFor(() => expect(h.request.mock.calls.filter(([o]) => o.url.endsWith('/api/me'))).toHaveLength(2));
    h.stored.set('barter.customer.accessToken', { accessToken: 'replacement-B', expiresAt: 900000 });
    replay.resolve({ statusCode: 200, data: actor(10) });
    expect(await identity).toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.session.getIdentity().actorId).toBeNull();
  });
  it('admits only the latest restored getMe and retains its unresolved command', async () => {
    const h = restoredHarness(); const late = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockReturnValueOnce(late.promise); const older = h.api.getMe().catch(error => error);
    h.request.mockResolvedValueOnce({ statusCode: 200, data: actor(10) }); await h.api.getMe();
    h.request.mockRejectedValueOnce(new Error('network unknown'));
    await expect(h.api.saveAddress(order.id, input)).rejects.toMatchObject({ message: 'network unknown' });
    late.resolve({ statusCode: 200, data: actor(10) });
    expect(await older).toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.api.getPendingCommand(order.id, orderId(10))).toMatchObject({ action: 'address' });
    await expect(h.api.retryOriginal(order.id, orderId(10))).resolves.toEqual({ order });
  });
  it.each(['address', 'self', 'outgoing'] as const)('does not replay or deliver %s across A to B automatic authentication', async operation => {
    const h = await harness();
    h.request.mockResolvedValueOnce({ statusCode: 401, data: {} }).mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'B', expiresIn: 900, user: actor(11) } }).mockResolvedValueOnce({ statusCode: 200, data: operation === 'address' ? { order } : privateView });
    const result = operation === 'address' ? h.api.saveAddress(order.id, input) : h.api.getShippingAddress(order.id, operation);
    await expect(result).rejects.toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.request.mock.calls.filter(([o]) => o.url.includes('/api/orders/'))).toHaveLength(1);
    expect(h.api.getPendingCommand(order.id, orderId(10))).toBeNull();
    expect(h.api.getPendingCommand(order.id, orderId(11))).toBeNull();
  });
  it('fails closed when refreshed authentication has no provable user', async () => {
    const h = await harness(); h.request.mockResolvedValueOnce({ statusCode: 401, data: {} }).mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'unknown', expiresIn: 900 } });
    await expect(h.api.saveAddress(order.id, input)).rejects.toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.request.mock.calls.filter(([o]) => o.url.includes('/api/orders/'))).toHaveLength(1);
    expect(h.api.getPendingCommand(order.id, orderId(10))).toBeNull();
  });
  it('preserves the original canonical body and key for a same-A refresh', async () => {
    const h = await harness(); h.request.mockResolvedValueOnce({ statusCode: 401, data: {} }).mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'A-new', expiresIn: 900, user: actor(10) } });
    await h.api.saveAddress(order.id, input);
    const posts = h.request.mock.calls.filter(([o]) => o.url.endsWith('/address')).map(([o]) => o);
    expect(posts).toHaveLength(2); expect(posts[1].data).toEqual(input); expect(posts[1].header?.['Idempotency-Key']).toBe(posts[0].header?.['Idempotency-Key']);
    expect(posts[1].header?.Authorization).toBe('Bearer A-new');
  });
  it('rejects late private completion and does not clear a newer session on an old 401', async () => {
    const h = await harness(); const late = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockReturnValueOnce(late.promise); const read = h.api.getShippingAddress(order.id, 'self').catch(e => e);
    h.session.clear(); h.request.mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'B', expiresIn: 900, user: actor(11) } }); await h.client.authenticate({ getCode: async () => 'B' });
    late.resolve({ statusCode: 401, data: {} });
    expect(await read).toMatchObject({ name: 'OrderIdentityChangedError' }); expect(h.session.getAccessToken()).toBe('B');
    expect(h.request.mock.calls.filter(([o]) => o.url.endsWith('/auth/wechat'))).toHaveLength(1);
  });
  it('rejects a successful private response after the session is cleared', async () => {
    const h = await harness(); const late = deferred<Awaited<ReturnType<RequestPort>>>(); h.request.mockReturnValueOnce(late.promise);
    const read = h.api.getShippingAddress(order.id, 'outgoing').catch(e => e); h.session.clear(); late.resolve({ statusCode: 200, data: privateView });
    expect(await read).toMatchObject({ name: 'OrderIdentityChangedError' });
  });
  it('coalesces concurrent 401 recovery and stops both old-actor operations', async () => {
    const h = await harness(); const auth = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockResolvedValueOnce({ statusCode: 401, data: {} }).mockResolvedValueOnce({ statusCode: 401, data: {} }).mockReturnValueOnce(auth.promise);
    const a = h.api.saveAddress(order.id, input).catch(e => e); const b = h.api.getShippingAddress(order.id, 'self').catch(e => e);
    await vi.waitFor(() => expect(h.request.mock.calls.filter(([o]) => o.url.endsWith('/auth/wechat'))).toHaveLength(1));
    auth.resolve({ statusCode: 201, data: { accessToken: 'B', expiresIn: 900, user: actor(11) } });
    expect(await a).toMatchObject({ name: 'OrderIdentityChangedError' }); expect(await b).toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.request.mock.calls.filter(([o]) => o.url.includes('/api/orders/'))).toHaveLength(2);
  });
  it('keeps an unknown original command across same-A expiry and remount authentication', async () => {
    const h = await harness(); h.request.mockRejectedValueOnce(new Error('network unknown'));
    await expect(h.api.saveAddress(order.id, input)).rejects.toMatchObject({ message: 'network unknown' });
    h.expire(); h.request.mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'A-fresh', expiresIn: 900, user: actor(10) } });
    await h.api.authenticate({ getCode: async () => 'A' });
    expect(h.api.getPendingCommand(order.id, orderId(10))).toMatchObject({ action: 'address' });
    await h.api.retryOriginal(order.id, orderId(10));
    const posts = h.request.mock.calls.filter(([o]) => o.url.endsWith('/address')).map(([o]) => o);
    expect(posts).toHaveLength(2); expect(posts[1].data).toEqual(input); expect(posts[1].header?.['Idempotency-Key']).toBe(posts[0].header?.['Idempotency-Key']);
  });
  it('does not send a retained A command with an externally replaced unproven stored credential', async () => {
    const h = await harness(); h.request.mockRejectedValueOnce(new Error('unknown'));
    await expect(h.api.saveAddress(order.id, input)).rejects.toMatchObject({ message: 'unknown' });
    h.stored.set('barter.customer.accessToken', { accessToken: 'external-B', expiresAt: 900000 });
    await expect(h.api.retryOriginal(order.id, orderId(10))).rejects.toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(h.request.mock.calls.filter(([o]) => o.url.endsWith('/address'))).toHaveLength(1);
    expect(h.api.getPendingCommand(order.id, orderId(10))).toBeNull();
  });
  it.each(['before-refresh', 'during-refresh'] as const)('preserves same-A original intent when token expires %s after a 401', async timing => {
    const h = await harness(); const auth = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockImplementationOnce(async () => { if (timing === 'before-refresh') h.expire(); return { statusCode: 401, data: {} }; }).mockReturnValueOnce(auth.promise);
    const outcome = h.api.saveAddress(order.id, input).then(value => ({ value }), error => ({ error }));
    if (timing === 'during-refresh') {
      await vi.waitFor(() => expect(h.request.mock.calls.some(([o]) => o.url.endsWith('/auth/wechat'))).toBe(true)); h.expire();
    }
    auth.resolve({ statusCode: 201, data: { accessToken: 'same-A-after-expiry', expiresIn: 900, user: actor(10) } });
    expect(await outcome).toMatchObject({ value: { order } });
    const posts = h.request.mock.calls.filter(([o]) => o.url.endsWith('/address')).map(([o]) => o);
    expect(posts).toHaveLength(2); expect(posts[1].data).toEqual(input); expect(posts[1].header?.['Idempotency-Key']).toBe(posts[0].header?.['Idempotency-Key']);
  });
  it('cannot overwrite an explicitly newer B session with a late A authentication response', async () => {
    const h = await harness(); const auth = deferred<Awaited<ReturnType<RequestPort>>>();
    h.request.mockResolvedValueOnce({ statusCode: 401, data: {} }).mockReturnValueOnce(auth.promise);
    const result = h.api.saveAddress(order.id, input).catch(error => error);
    await vi.waitFor(() => expect(h.request.mock.calls.some(([o]) => o.url.endsWith('/auth/wechat'))).toBe(true));
    h.session.setAccessToken('explicit-new-B', 900, orderId(11));
    auth.resolve({ statusCode: 201, data: { accessToken: 'late-A', expiresIn: 900, user: actor(10) } });
    expect(await result).toMatchObject({ name: 'OrderIdentityChangedError' }); expect(h.session.getAccessToken()).toBe('explicit-new-B');
    expect(h.session.getIdentity().actorId).toBe(orderId(11)); expect(h.api.getPendingCommand(order.id, orderId(10))).toBeNull();
    expect(h.request.mock.calls.filter(([o]) => o.url.endsWith('/address'))).toHaveLength(1);
  });
});
