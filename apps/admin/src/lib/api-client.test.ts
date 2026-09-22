import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, loadStoredSession } from './api-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('authenticated API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs in with the admin password endpoint and bootstraps the stored token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, {
        accessToken: 'operator-token',
        expiresIn: 900,
        user: { id: 'operator-1', roles: ['REVIEWER'] },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'operator-1', roles: ['REVIEWER'] }));
    const client = createApiClient({ fetchImpl: fetchMock });

    await expect(client.login('reviewer@example.test', 'password')).resolves.toMatchObject({
      user: { roles: ['REVIEWER'] },
    });
    await expect(client.bootstrapSession()).resolves.toEqual({
      id: 'operator-1',
      roles: ['REVIEWER'],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/admin/password');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer operator-token' }),
    });
  });

  it('never retries FORBIDDEN responses', async () => {
    window.sessionStorage.setItem('barter-admin-session', JSON.stringify({
      accessToken: 'operator-token',
      expiresAt: Date.now() + 60_000,
      user: { id: 'operator-1', roles: ['REVIEWER'] },
    }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, {
      code: 'FORBIDDEN',
      message: 'Review permission is required',
      requestId: 'request-forbidden',
    }));
    const client = createApiClient({ fetchImpl: fetchMock });

    await expect(client.reviewItem('item-1', {
      decision: 'APPROVE',
      expectedVersion: 3,
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('clears expired authentication and does not replay a review', async () => {
    window.sessionStorage.setItem('barter-admin-session', JSON.stringify({
      accessToken: 'expired-token',
      expiresAt: Date.now() + 60_000,
      user: { id: 'operator-1', roles: ['REVIEWER'] },
    }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {
      code: 'AUTH_REQUIRED',
      message: 'Access token has expired',
      requestId: 'request-expired',
    }));
    const onExpired = vi.fn();
    window.addEventListener('barter:auth-expired', onExpired, { once: true });
    const client = createApiClient({ fetchImpl: fetchMock });

    await expect(client.reviewItem('item-1', {
      decision: 'APPROVE',
      expectedVersion: 3,
    })).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(loadStoredSession()).toBeNull();
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it('does not send a review after the locally stored session expires', async () => {
    window.sessionStorage.setItem('barter-admin-session', JSON.stringify({
      accessToken: 'expired-token',
      expiresAt: Date.now() - 1,
      user: { id: 'operator-1', roles: ['REVIEWER'] },
    }));
    const fetchMock = vi.fn();
    const onExpired = vi.fn();
    window.addEventListener('barter:auth-expired', onExpired, { once: true });
    const client = createApiClient({ fetchImpl: fetchMock });

    await expect(client.reviewItem('item-1', {
      decision: 'APPROVE',
      expectedVersion: 3,
    })).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' } satisfies Partial<ApiError>);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onExpired).toHaveBeenCalledOnce();
  });
});
