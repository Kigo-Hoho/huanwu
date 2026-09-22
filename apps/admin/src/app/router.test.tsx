import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRouter } from './router';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('operator router', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('protects review routes and logs in through the password endpoint', async () => {
    window.history.replaceState({}, '', '/reviews');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, {
        accessToken: 'operator-token',
        expiresIn: 900,
        user: { id: 'operator-1', roles: ['REVIEWER'] },
      }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AppRouter />);

    expect(await screen.findByRole('heading', { name: '运营审核登录' })).toBeVisible();
    await user.type(screen.getByLabelText('邮箱'), 'reviewer@example.test');
    await user.type(screen.getByLabelText('密码'), 'password');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '待审核物品' })).toBeVisible();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/admin/password');
  });

  it('clears a forbidden bootstrap session and shows the API message without retrying', async () => {
    window.history.replaceState({}, '', '/reviews');
    window.sessionStorage.setItem('barter-admin-session', JSON.stringify({
      accessToken: 'revoked-operator-token',
      expiresAt: Date.now() + 60_000,
      user: { id: 'operator-1', roles: ['REVIEWER'] },
    }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, {
      code: 'FORBIDDEN',
      message: 'Operator permission is required',
      requestId: 'request-bootstrap-forbidden',
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<AppRouter />);

    expect(await screen.findByRole('heading', { name: '运营审核登录' })).toBeVisible();
    expect(screen.getByText('FORBIDDEN：Operator permission is required')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('barter-admin-session')).toBeNull();
  });

});
