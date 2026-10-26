import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-client';
import { createAdminAfterSalesApi } from './after-sales-api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function storePasswordSession(): void {
  window.sessionStorage.setItem('barter-admin-session', JSON.stringify({
    accessToken: 'password-token',
    expiresAt: Date.now() + 60_000,
    user: { id: 'operator-1', roles: ['SUPER_ADMIN'] },
  }));
}

describe('bound operator session requests', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('keeps the password login when a sensitive route still needs a bound session', async () => {
    storePasswordSession();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {
      code: 'REAUTH_REQUIRED',
      message: 'Bound operator session required',
      requestId: 'request-reauth',
    }));
    const onExpired = vi.fn();
    window.addEventListener('barter:auth-expired', onExpired);
    const api = createAdminAfterSalesApi({ fetchImpl: fetchMock });

    await expect(api.listDevices()).rejects.toMatchObject({
      status: 401,
      code: 'REAUTH_REQUIRED',
    } satisfies Partial<ApiError>);
    expect(window.sessionStorage.getItem('barter-admin-session')).toContain('password-token');
    expect(onExpired).not.toHaveBeenCalled();
    window.removeEventListener('barter:auth-expired', onExpired);
  });

  it('clears the password login when the access token itself is rejected', async () => {
    storePasswordSession();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {
      code: 'AUTH_REQUIRED',
      message: 'Access token has expired',
      requestId: 'request-expired',
    }));
    const onExpired = vi.fn();
    window.addEventListener('barter:auth-expired', onExpired);
    const api = createAdminAfterSalesApi({ fetchImpl: fetchMock });

    await expect(api.listDevices()).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
    expect(window.sessionStorage.getItem('barter-admin-session')).toBeNull();
    expect(onExpired).toHaveBeenCalledOnce();
    window.removeEventListener('barter:auth-expired', onExpired);
  });
});
