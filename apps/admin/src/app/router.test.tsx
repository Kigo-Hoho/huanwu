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
});
