import {
  CreateItemSchema,
  CreateProposalSchema,
  CounterProposalSchema,
  AcceptProposalSchema,
  type CreateProposalInput,
  type CounterProposalInput,
  type ProposalCommandInput,
  type ProposalView,
  type ItemView,
  type PublicItemList,
  type PublicItemView,
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
export type OrderRequestPath = `/api/orders/${string}` | `/api/me/orders${string}` | `/api/proposals/${string}/order` | `/api/testing/payments/${string}/complete` | `/api/testing/shipments/${string}/progress`;

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
  private identityProvider: IdentityCodeProvider | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly session: Session,
    private readonly request: RequestPort = (options) =>
      Taro.request(options as Taro.request.Option) as Promise<RequestResult>,
  ) {}

  async authenticate(identityProvider: IdentityCodeProvider): Promise<void> {
    this.identityProvider = identityProvider;
    if (this.session.getAccessToken()) return;
    await this.createSession(identityProvider);
  }

  private async createSession(identityProvider: IdentityCodeProvider): Promise<void> {
    const code = await identityProvider.getCode();
    const response = await this.send<AuthSessionResponse>({
      url: '/api/auth/wechat',
      method: 'POST',
      data: { code },
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      typeof response.accessToken !== 'string' ||
      typeof response.expiresIn !== 'number' ||
      !Number.isFinite(response.expiresIn) ||
      response.expiresIn <= 0
    ) {
      throw new Error('登录响应无效。');
    }
    this.session.setAccessToken(response.accessToken, response.expiresIn);
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
      true,
    );
  }

  listMyItems(): Promise<ItemView[]> {
    return this.authorized<ItemView[]>('/api/me/items', 'GET', undefined, {}, true);
  }

  getMe(): Promise<{ id: string; roles: Role[] }> {
    return this.authorized('/api/me', 'GET', undefined, {}, true);
  }

  // Dedicated composition seam; validation and logical keys belong to OrderApi.
  orderRequest(path: OrderRequestPath, method: 'GET' | 'POST', data?: unknown, key?: string): Promise<unknown> {
    return this.authorized(path, method, data, key ? { 'Idempotency-Key': key } : {}, true);
  }

  listProposals(direction: 'sent' | 'received'): Promise<ProposalView[]> {
    return this.authorized(`/api/me/proposals?direction=${direction}`, 'GET', undefined, {}, true);
  }

  getProposal(id: string): Promise<ProposalView> {
    return this.authorized(`/api/proposals/${encodeURIComponent(id)}`, 'GET', undefined, {}, true);
  }

  createProposal(input: CreateProposalInput, key: string): Promise<ProposalView> {
    return this.authorized('/api/proposals', 'POST', CreateProposalSchema.parse(input), { 'Idempotency-Key': key }, true);
  }

  commandProposal(id: string, action: 'counter' | 'accept' | 'reject' | 'cancel', input: CounterProposalInput | ProposalCommandInput, key: string): Promise<ProposalView> {
    const body = action === 'counter' ? CounterProposalSchema.parse(input) : AcceptProposalSchema.parse(input);
    return this.authorized(`/api/proposals/${encodeURIComponent(id)}/${action}`, 'POST', body, { 'Idempotency-Key': key }, true);
  }

  getMyItem(itemId: string): Promise<ItemView> {
    return this.authorized<ItemView>(
      `/api/me/items/${encodeURIComponent(itemId)}`,
      'GET',
      undefined,
      {},
      true,
    );
  }

  listPublicItems(cursor?: string): Promise<PublicItemList> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.send<PublicItemList>({ url: `/api/items${query}`, method: 'GET' });
  }

  getPublicItem(itemId: string): Promise<PublicItemView> {
    return this.send<PublicItemView>({ url: `/api/items/${encodeURIComponent(itemId)}`, method: 'GET' });
  }

  private async authorized<T>(
    path: string,
    method: RequestOptions['method'],
    data?: unknown,
    additionalHeaders: Record<string, string> = {},
    retryAfterAuthentication = false,
  ): Promise<T> {
    const execute = (): Promise<T> => {
      const token = this.session.getAccessToken();
      if (!token) throw new Error('Customer authentication is required.');
      return this.send<T>({
        url: path,
        method,
        data,
        header: { Authorization: `Bearer ${token}`, ...additionalHeaders },
      });
    };

    try {
      return await execute();
    } catch (cause) {
      if (!(cause instanceof ApiClientError) || cause.statusCode !== 401) throw cause;
      this.session.clear();
      if (!this.identityProvider) throw cause;
      await this.createSession(this.identityProvider);
      if (!retryAfterAuthentication) throw cause;
      try {
        return await execute();
      } catch (retryCause) {
        if (retryCause instanceof ApiClientError && retryCause.statusCode === 401) {
          this.session.clear();
        }
        throw retryCause;
      }
    }
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
