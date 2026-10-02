import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WechatIdentityProvider } from './wechat-identity.provider.js';

const originalAppId = process.env.WECHAT_APP_ID;
const originalAppSecret = process.env.WECHAT_APP_SECRET;

describe('WechatIdentityProvider', () => {
  beforeEach(() => {
    process.env.WECHAT_APP_ID = 'test-app-id';
    process.env.WECHAT_APP_SECRET = 'test-app-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalAppId === undefined) delete process.env.WECHAT_APP_ID;
    else process.env.WECHAT_APP_ID = originalAppId;
    if (originalAppSecret === undefined) delete process.env.WECHAT_APP_SECRET;
    else process.env.WECHAT_APP_SECRET = originalAppSecret;
  });

  it('maps unavailable configuration to an explicit 503 identity-provider error', async () => {
    delete process.env.WECHAT_APP_ID;

    await expect(
      new WechatIdentityProvider().exchangeCode('customer-code'),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'WeChat identity provider is not configured',
      },
    });
  });

  it('maps an upstream HTTP failure to an explicit 502 identity-provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 502 })),
    );

    await expect(
      new WechatIdentityProvider().exchangeCode('customer-code'),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'WeChat identity exchange failed',
      },
    });
  });

  it('maps an upstream network failure to an explicit 502 identity-provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('network unavailable')),
    );

    await expect(
      new WechatIdentityProvider().exchangeCode('customer-code'),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'WeChat identity exchange failed',
      },
    });
  });

  it('aborts a stalled upstream exchange and maps it to an explicit 504 error', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (!requestSignal) {
            setTimeout(
              () => reject(new Error('fetch was called without an abort signal')),
              5_000,
            );
            return;
          }
          requestSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
    );

    const exchange = new WechatIdentityProvider()
      .exchangeCode('customer-code')
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(exchange).resolves.toMatchObject({
      status: 504,
      response: {
        code: 'IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'WeChat identity exchange timed out',
      },
    });
    expect(requestSignal?.aborted).toBe(true);
  });
});
