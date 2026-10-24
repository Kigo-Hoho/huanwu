import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedApiClient } from '../../lib/api-client';
import { Session } from '../auth/session';
import { AfterSalesApi } from './after-sales-api';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caseView = {
  id: id(50), orderId: id(20), rootDisputeId: id(50), status: 'AWAITING_AGREEMENT' as const, version: 2,
  reason: '物品与描述不符', currentResolutionVersion: 1, responseDeadline: null,
  agreementDeadline: '2099-10-10T00:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z',
};
const commandResult = { case: caseView, orderVersion: 5 };
const consentInput = { expectedCaseVersion: 2, expectedOrderVersion: 5, resolutionVersion: 1, decision: 'AGREE' as const };

function harness() {
  const stored = new Map<string, unknown>();
  const storage = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => { stored.set(key, value); },
    removeStorageSync: (key: string) => { stored.delete(key); },
  };
  const session = new Session(storage);
  session.setAccessToken('token', 900, id(10));
  const request = vi.fn().mockResolvedValue({ statusCode: 200, data: commandResult });
  const upload = vi.fn().mockResolvedValue({ statusCode: 200, data: JSON.stringify(commandResult) });
  const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
  const api = new AfterSalesApi(client, { uploadFile: upload, baseUrl: 'http://localhost:3000' });
  return { api, request, upload, client, session, stored };
}

describe('after-sales api logical commands', () => {
  it('reuses the original body and key after an uncertain result and rejects changed content', async () => {
    const { api, request } = harness();
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(api.consent(caseView.id, consentInput)).rejects.toThrow();
    await expect(api.consent(caseView.id, { ...consentInput, decision: 'REJECT', reason: '不同意' }))
      .rejects.toMatchObject({ message: expect.stringContaining('结果未明') });
    await api.consent(caseView.id, consentInput);
    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[1]![0].data).toEqual(consentInput);
    expect(request.mock.calls[1]![0].header['Idempotency-Key']).toBe(request.mock.calls[0]![0].header['Idempotency-Key']);
  });

  it('does not let a 401 refresh replay an open-case body under a new actor', async () => {
    const { api, request, client } = harness();
    await client.authenticate({ getCode: async () => 'code' });
    request.mockResolvedValueOnce({ statusCode: 401, data: {} });
    request.mockResolvedValueOnce({ statusCode: 201, data: { accessToken: 'fresh', expiresIn: 900, user: { id: id(11), roles: ['CUSTOMER'] } } });
    await expect(api.open(id(20), { expectedOrderVersion: 3, reason: '质量问题' })).rejects.toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(request.mock.calls.filter(c => String(c[0].url).includes('/after-sales') && c[0].method === 'POST')).toHaveLength(1);
  });

  it('clears pending commands and evidence object URLs when identity changes', async () => {
    const { api, request } = harness();
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:evidence-a', revokeObjectURL: revoke });
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(10), roles: ['CUSTOMER'] } });
    await api.getMe();
    request.mockRejectedValueOnce(new Error('unknown'));
    await expect(api.respond(caseView.id, { expectedCaseVersion: 2, expectedOrderVersion: 5, description: '补充说明' })).rejects.toThrow();
    expect(api.getPendingCommand(caseView.id, id(10))?.action).toBe('respond');
    request.mockResolvedValueOnce({ statusCode: 200, data: new Uint8Array([1, 2, 3]).buffer });
    const url = await api.readEvidencePreview(id(60));
    expect(url).toBe('blob:evidence-a');
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(11), roles: ['CUSTOMER'] } });
    await api.getMe();
    expect(api.getPendingCommand(caseView.id, id(11))).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:evidence-a');
    vi.unstubAllGlobals();
  });

  it('discards a late evidence preview that arrives after identity switch', async () => {
    const { api, request } = harness();
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:stale', revokeObjectURL: revoke });
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(10), roles: ['CUSTOMER'] } });
    await api.getMe();
    let finish!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const late = api.readEvidencePreview(id(60));
    request.mockResolvedValueOnce({ statusCode: 200, data: { id: id(11), roles: ['CUSTOMER'] } });
    await api.getMe();
    finish({ statusCode: 200, data: new Uint8Array([9]).buffer });
    await expect(late).rejects.toMatchObject({ name: 'OrderIdentityChangedError' });
    expect(revoke).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('blocks simulation compensation complete outside allowed builds', async () => {
    const { api, request } = harness();
    await expect(api.completeTestCompensation(id(70), { expectedCaseVersion: 2, expectedOrderVersion: 5, resolutionVersion: 1 }))
      .rejects.toMatchObject({ message: expect.stringContaining('测试驱动未启用') });
    expect(request).not.toHaveBeenCalled();
  });

  it('maps customer after-sales commands onto domain paths with shared contracts', async () => {
    const { api, request } = harness();
    await api.open(id(20), { expectedOrderVersion: 3, reason: '质量问题' });
    expect(request.mock.lastCall![0].url).toBe('http://localhost:3000/api/orders/' + id(20) + '/after-sales');
    request.mockResolvedValueOnce({ statusCode: 200, data: { ...caseView, records: [], evidence: [], resolutions: [], compensation: [] } });
    await api.get(caseView.id);
    expect(request.mock.lastCall![0].url).toBe('http://localhost:3000/api/after-sales/' + caseView.id);
    await api.confirmKeep(caseView.id, { expectedCaseVersion: 2, expectedOrderVersion: 5, resolutionVersion: 1 });
    expect(request.mock.lastCall![0].url).toContain('/keep-confirmation');
    request.mockResolvedValueOnce({ statusCode: 201, data: { resourceId: id(80), version: 1 } });
    await api.report({ targetType: 'ITEM', targetId: id(1), reason: 'PROHIBITED_ITEM', description: '违禁品', expectedTargetVersion: 1 });
    expect(request.mock.lastCall![0].url).toBe('http://localhost:3000/api/reports');
  });
});
