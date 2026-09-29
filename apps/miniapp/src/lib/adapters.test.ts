import type { ItemView } from '@barter/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  AcceptanceH5IdentityCodeProvider,
  TaroIdentityCodeProvider,
  createIdentityCodeProvider,
} from '../features/auth/identity-code.provider';
import { Session, type SynchronousStorage } from '../features/auth/session';
import { ImageUploadClient } from '../features/images/image-upload.client';
import { AuthenticatedApiClient } from './api-client';

class MemoryStorage implements SynchronousStorage {
  readonly values = new Map<string, unknown>();

  getStorageSync(key: string): unknown {
    return this.values.get(key);
  }

  setStorageSync(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  removeStorageSync(key: string): void {
    this.values.delete(key);
  }
}

const item: ItemView = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  title: '九成新连衣裙',
  description: '袖口轻微使用痕迹，照片已经完整展示。',
  referenceValueFen: 12_345,
  condition: 'GOOD',
  imageUrls: [
    'https://images.example.test/1.jpg',
    'https://images.example.test/2.jpg',
    'https://images.example.test/3.jpg',
  ],
  wantedText: '',
  status: 'PENDING_REVIEW',
  version: 2,
  rejectReason: null,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:01:00.000Z',
};

describe('customer adapters', () => {
  it('stores, reads, and clears the access token through the session abstraction', () => {
    const storage = new MemoryStorage();
    const session = new Session(storage);

    expect(session.getAccessToken()).toBeNull();
    session.setAccessToken('customer-token', 900);
    expect(session.getAccessToken()).toBe('customer-token');
    session.clear();
    expect(session.getAccessToken()).toBeNull();
  });

  it('expires a persisted session by absolute time and authenticates again', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const originalSession = new Session(storage, () => now);
    originalSession.setAccessToken('expired-token', 1);
    now += 1_001;

    const restoredSession = new Session(storage, () => now);
    const request = vi.fn().mockResolvedValue({
      statusCode: 201,
      data: {
        accessToken: 'fresh-token',
        expiresIn: 900,
        user: { id: item.ownerId, roles: ['CUSTOMER'] },
      },
    });
    const identity = { getCode: vi.fn().mockResolvedValue('new-wechat-code') };
    const client = new AuthenticatedApiClient(
      'http://localhost:3000',
      restoredSession,
      request,
    );

    await client.authenticate(identity);

    expect(identity.getCode).toHaveBeenCalledTimes(1);
    expect(restoredSession.getAccessToken()).toBe('fresh-token');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:3000/api/auth/wechat',
        data: { code: 'new-wechat-code' },
      }),
    );
  });

  it('gets the customer code from the injected Taro login boundary', async () => {
    const login = vi.fn().mockResolvedValue({ code: 'wechat-customer-code' });

    await expect(new TaroIdentityCodeProvider(login).getCode()).resolves.toBe(
      'wechat-customer-code',
    );
  });

  it('allows the deterministic identity only for explicit non-production H5 acceptance builds', async () => {
    const provider = createIdentityCodeProvider({
      provider: 'acceptance',
      target: 'h5',
      buildEnvironment: 'test',
    });

    expect(provider).toBeInstanceOf(AcceptanceH5IdentityCodeProvider);
    await expect(provider.getCode()).resolves.toBe('e2e-customer-code');
    expect(() =>
      createIdentityCodeProvider({
        provider: 'acceptance',
        target: 'h5',
        buildEnvironment: 'production',
      }),
    ).toThrow(/production/i);
    expect(() =>
      createIdentityCodeProvider({
        provider: 'acceptance',
        target: 'weapp',
        buildEnvironment: 'test',
      }),
    ).toThrow(/H5/i);
  });

  it('rejects an unknown identity provider instead of silently weakening build configuration', () => {
    expect(() =>
      createIdentityCodeProvider({
        provider: 'typo-provider',
        target: 'h5',
        buildEnvironment: 'test',
      }),
    ).toThrow(/unknown identity provider/i);
  });

  it('selects either explicitly injected acceptance customer and rejects unknown codes', async () => {
    const provider = createIdentityCodeProvider({ provider: 'acceptance', target: 'h5', buildEnvironment: 'acceptance' });
    try {
      for (const code of ['e2e-customer-code', 'e2e-customer-two-code']) {
        vi.stubGlobal('__BARTER_ACCEPTANCE_IDENTITY_CODE__', code);
        await expect(provider.getCode()).resolves.toBe(code);
      }
      vi.stubGlobal('__BARTER_ACCEPTANCE_IDENTITY_CODE__', 'unknown-customer');
      await expect(provider.getCode()).rejects.toMatchObject({ message: 'Invalid acceptance identity code.' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores acceptance injection for the production Taro provider without falling back on login failure', async () => {
    vi.stubGlobal('__BARTER_ACCEPTANCE_IDENTITY_CODE__', 'e2e-customer-two-code');
    try {
      const configuration = { provider: 'taro', target: 'h5', buildEnvironment: 'production' };
      await expect(createIdentityCodeProvider(configuration, async () => ({ code: 'real-code' })).getCode()).resolves.toBe('real-code');
      await expect(createIdentityCodeProvider(configuration, async () => { throw new Error('WeChat unavailable'); }).getCode()).rejects.toMatchObject({ message: 'WeChat unavailable' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('authenticates once, persists the token, and sends an idempotent authorized submission', async () => {
    const session = new Session(new MemoryStorage());
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 201,
        data: {
          accessToken: 'customer-token',
          expiresIn: 900,
          user: { id: item.ownerId, roles: ['CUSTOMER'] },
        },
      })
      .mockResolvedValueOnce({ statusCode: 200, data: item });
    const client = new AuthenticatedApiClient('http://localhost:3000/', session, request);
    const identity = { getCode: vi.fn().mockResolvedValue('wechat-code') };

    await client.authenticate(identity);
    await expect(client.submitItem(item.id, 'submit-command-1')).resolves.toEqual(item);

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: 'http://localhost:3000/api/auth/wechat',
      method: 'POST',
      data: { code: 'wechat-code' },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      url: `http://localhost:3000/api/items/${item.id}/submit`,
      method: 'POST',
      header: {
        Authorization: 'Bearer customer-token',
        'Idempotency-Key': 'submit-command-1',
      },
    });
  });

  it('refreshes a rejected token and retries a safe request only once', async () => {
    const session = new Session(new MemoryStorage());
    session.setAccessToken('stale-token', 900);
    const unauthorized = {
      statusCode: 401,
      data: { message: 'Access token has expired' },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce({
        statusCode: 201,
        data: {
          accessToken: 'fresh-token',
          expiresIn: 900,
          user: { id: item.ownerId, roles: ['CUSTOMER'] },
        },
      })
      .mockResolvedValueOnce(unauthorized);
    const identity = { getCode: vi.fn().mockResolvedValue('fresh-wechat-code') };
    const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
    await client.authenticate(identity);

    await expect(client.listMyItems()).rejects.toMatchObject({ statusCode: 401 });

    expect(identity.getCode).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      header: { Authorization: 'Bearer stale-token' },
    });
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      method: 'GET',
      header: { Authorization: 'Bearer fresh-token' },
    });
  });

  it('refreshes after an unsafe request gets 401 without replaying that request', async () => {
    const session = new Session(new MemoryStorage());
    session.setAccessToken('stale-token', 900);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 401,
        data: { message: 'Access token has expired' },
      })
      .mockResolvedValueOnce({
        statusCode: 201,
        data: {
          accessToken: 'fresh-token',
          expiresIn: 900,
          user: { id: item.ownerId, roles: ['CUSTOMER'] },
        },
      });
    const identity = { getCode: vi.fn().mockResolvedValue('fresh-wechat-code') };
    const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
    await client.authenticate(identity);

    await expect(client.createItem(item)).rejects.toMatchObject({ statusCode: 401 });

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.filter(([options]) => options.url.endsWith('/api/items')),
    ).toHaveLength(1);
    expect(session.getAccessToken()).toBe('fresh-token');
  });

  it('replays an idempotency-keyed submit once with the same command key after 401', async () => {
    const session = new Session(new MemoryStorage());
    session.setAccessToken('stale-token', 900);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 401,
        data: { message: 'Access token has expired' },
      })
      .mockResolvedValueOnce({
        statusCode: 201,
        data: {
          accessToken: 'fresh-token',
          expiresIn: 900,
          user: { id: item.ownerId, roles: ['CUSTOMER'] },
        },
      })
      .mockResolvedValueOnce({ statusCode: 200, data: item });
    const identity = { getCode: vi.fn().mockResolvedValue('fresh-wechat-code') };
    const client = new AuthenticatedApiClient('http://localhost:3000', session, request);
    await client.authenticate(identity);

    await expect(client.submitItem(item.id, 'one-logical-command')).resolves.toEqual(item);

    const submitRequests = request.mock.calls
      .map(([options]) => options)
      .filter((options) => options.url.endsWith(`/api/items/${item.id}/submit`));
    expect(submitRequests).toHaveLength(2);
    expect(submitRequests[0]).toMatchObject({
      header: {
        Authorization: 'Bearer stale-token',
        'Idempotency-Key': 'one-logical-command',
      },
    });
    expect(submitRequests[1]).toMatchObject({
      header: {
        Authorization: 'Bearer fresh-token',
        'Idempotency-Key': 'one-logical-command',
      },
    });
  });

  it('uploads the selected file with the stored bearer token and returns its HTTP URL', async () => {
    const session = new Session(new MemoryStorage());
    session.setAccessToken('customer-token', 900);
    const uploadFile = vi.fn().mockResolvedValue({
      statusCode: 201,
      data: JSON.stringify({ url: 'https://images.example.test/uploaded.jpg' }),
    });
    const client = new ImageUploadClient('http://localhost:3000', session, uploadFile);

    await expect(client.upload('wxfile://selected.jpg')).resolves.toBe(
      'https://images.example.test/uploaded.jpg',
    );
    expect(uploadFile).toHaveBeenCalledWith({
      url: 'http://localhost:3000/api/uploads/item-images',
      filePath: 'wxfile://selected.jpg',
      name: 'file',
      header: { Authorization: 'Bearer customer-token' },
    });
  });

  it('rejects a successful upload response whose URL is not HTTP', async () => {
    const session = new Session(new MemoryStorage());
    session.setAccessToken('customer-token', 900);
    const client = new ImageUploadClient(
      'http://localhost:3000',
      session,
      vi.fn().mockResolvedValue({
        statusCode: 201,
        data: JSON.stringify({ url: 'ftp://images.example.test/uploaded.jpg' }),
      }),
    );

    await expect(client.upload('wxfile://selected.jpg')).rejects.toThrow();
  });
});
