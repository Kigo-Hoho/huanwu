import {
  CreateItemSchema,
  type ItemView,
  type Role,
} from '@barter/contracts';
import Taro from '@tarojs/taro';

import type { IdentityCodeProvider } from '../features/auth/identity-code.provider';
import type { Session } from '../features/auth/session';

type CreateItem = Pick<
  ItemView,
  'title' | 'description' | 'referenceValueFen' | 'condition' | 'imageUrls' | 'wantedText'
>;

interface RequestOptions {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  data?: unknown;
  header?: Record<string, string>;
}

interface RequestResult {
  statusCode: number;
  data: unknown;
}

export type RequestPort = (options: RequestOptions) => Promise<RequestResult>;

interface AuthSessionResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; roles: Role[] };
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function errorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = body.message;
    if (typeof message === 'string') return message;
  }
  return '请求失败，请稍后重试。';
}

export class AuthenticatedApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly session: Session,
    private readonly request: RequestPort = (options) =>
      Taro.request(options as Taro.request.Option) as Promise<RequestResult>,
  ) {}

  async authenticate(identityProvider: IdentityCodeProvider): Promise<void> {
    if (this.session.getAccessToken()) return;
    const code = await identityProvider.getCode();
    const response = await this.send<AuthSessionResponse>({
      url: '/api/auth/wechat',
      method: 'POST',
      data: { code },
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      typeof response.accessToken !== 'string'
    ) {
      throw new Error('登录响应无效。');
    }
    this.session.setAccessToken(response.accessToken);
  }

  createItem(input: CreateItem): Promise<ItemView> {
    return this.authorized<ItemView>('/api/items', 'POST', CreateItemSchema.parse(input));
  }

  updateItem(itemId: string, input: Partial<CreateItem>): Promise<ItemView> {
    return this.authorized<ItemView>(`/api/items/${encodeURIComponent(itemId)}`, 'PATCH', input);
  }

  submitItem(itemId: string, idempotencyKey: string): Promise<ItemView> {
    return this.authorized<ItemView>(
      `/api/items/${encodeURIComponent(itemId)}/submit`,
      'POST',
      undefined,
      { 'Idempotency-Key': idempotencyKey },
    );
  }

  listMyItems(): Promise<ItemView[]> {
    return this.authorized<ItemView[]>('/api/me/items', 'GET');
  }

  getMyItem(itemId: string): Promise<ItemView> {
    return this.authorized<ItemView>(`/api/me/items/${encodeURIComponent(itemId)}`, 'GET');
  }

  private async authorized<T>(
    path: string,
    method: RequestOptions['method'],
    data?: unknown,
    additionalHeaders: Record<string, string> = {},
  ): Promise<T> {
    const token = this.session.getAccessToken();
    if (!token) throw new Error('Customer authentication is required.');
    return this.send<T>({
      url: path,
      method,
      data,
      header: { Authorization: `Bearer ${token}`, ...additionalHeaders },
    });
  }

  private async send<T>(options: RequestOptions): Promise<T> {
    const result = await this.request({
      ...options,
      url: `${this.baseUrl.replace(/\/$/, '')}${options.url}`,
      header: { 'Content-Type': 'application/json', ...options.header },
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new ApiClientError(errorMessage(result.data), result.statusCode, result.data);
    }
    return result.data as T;
  }
}
