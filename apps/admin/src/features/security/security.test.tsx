import type { OperatorDeviceView, OperatorSessionView } from '@barter/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import { DevicePage } from './device-page';
import { ReauthDialog } from './reauth-dialog';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true };

const device = (patch: Partial<OperatorDeviceView> = {}): OperatorDeviceView => ({
  id: id(1),
  version: 1,
  capability: 'MOBILE_LIMITED',
  status: 'PENDING',
  createdAt: '2026-10-20T00:00:00.000Z',
  approvedAt: null,
  revokedAt: null,
  ...patch,
});

const session = (patch: Partial<OperatorSessionView> = {}): OperatorSessionView => ({
  id: id(2),
  version: 1,
  deviceId: id(1),
  capability: 'MOBILE_LIMITED',
  expiresAt: '2026-10-20T01:00:00.000Z',
  ...patch,
});

afterEach(() => {
  window.sessionStorage.clear();
});

it('shows pending device with controlled bootstrap notice and never auto-approves', async () => {
  const currentDevice = vi.fn().mockResolvedValue(device());
  const client = {
    listDevices: vi.fn().mockResolvedValue({ items: [device()], nextCursor: null }),
    currentDevice,
    listSessions: vi.fn().mockResolvedValue({ items: [session()], nextCursor: null }),
    revokeSession: vi.fn(),
    securityLogin: vi.fn(),
    clearSensitiveState: vi.fn(),
    getBoundSession: () => null,
    onIdentityChange: () => () => undefined,
  };
  render(
    <MemoryRouter future={routerFuture}>
      <DevicePage client={client} />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/不会自动批准桌面能力/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '登记当前设备（待批准）' }));
  await waitFor(() => expect(currentDevice).toHaveBeenCalled());
  expect(await screen.findByText(/受控 bootstrap 批准前不能取得 DESKTOP_PRIVILEGED/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /批准设备|自动批准/ })).not.toBeInTheDocument();
});

it('clears password field and device form evidence on identity change', async () => {
  let listener: (() => void) | undefined;
  const client = {
    listDevices: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    currentDevice: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    revokeSession: vi.fn(),
    securityLogin: vi.fn(),
    clearSensitiveState: vi.fn(),
    getBoundSession: () => null,
    onIdentityChange: (cb: () => void) => {
      listener = cb;
      return () => undefined;
    },
  };
  render(
    <MemoryRouter future={routerFuture}>
      <DevicePage client={client} />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText('运营密码'), { target: { value: 'should-clear' } });
  act(() => listener?.());
  expect(screen.getByLabelText('运营密码')).toHaveValue('');
});

it('reauth dialog passes password once and does not keep it after confirm', async () => {
  const onConfirm = vi.fn(async () => undefined);
  const view = render(
    <ReauthDialog open title="重验" summary="固定正文" onCancel={() => undefined} onConfirm={onConfirm} />,
  );
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'one-shot' } });
  fireEvent.click(screen.getByRole('button', { name: '重新验证并执行' }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('one-shot'));
  expect(screen.getByLabelText('管理员密码')).toHaveValue('');
  view.rerender(
    <ReauthDialog open={false} title="重验" summary="固定正文" onCancel={() => undefined} onConfirm={onConfirm} />,
  );
  view.rerender(
    <ReauthDialog open title="重验" summary="固定正文" onCancel={() => undefined} onConfirm={onConfirm} />,
  );
  expect(screen.getByLabelText('管理员密码')).toHaveValue('');
});

it('surfaces revoke session API failures clearly', async () => {
  const revokeSession = vi.fn().mockRejectedValue(new ApiError(409, { code: 'VALIDATION_FAILED', message: 'version conflict', requestId: 'r' }));
  const client = {
    listDevices: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    currentDevice: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ items: [session()], nextCursor: null }),
    revokeSession,
    securityLogin: vi.fn(),
    clearSensitiveState: vi.fn(),
    getBoundSession: () => null,
    onIdentityChange: () => () => undefined,
  };
  render(
    <MemoryRouter future={routerFuture}>
      <DevicePage client={client} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '撤销会话' }));
  expect(await screen.findByText(/VALIDATION_FAILED：version conflict/)).toBeVisible();
});
