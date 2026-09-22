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

  setStorageSync(key: string, value: string): void {
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
    session.setAccessToken('customer-token');
    expect(session.getAccessToken()).toBe('customer-token');
    session.clear();
    expect(session.getAccessToken()).toBeNull();
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

  it('uploads the selected file with the stored bearer token and returns its HTTP URL', async () => {
    const session = new Session(new MemoryStorage());
    session.setAccessToken('customer-token');
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
    session.setAccessToken('customer-token');
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
