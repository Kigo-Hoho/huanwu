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
  RoleValues,
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

export class OrderIdentityChangedError extends ApiClientError {
  constructor() { super('登录身份已变化或无法核实，请刷新订单并重新确认操作。', 409, { code: 'ORDER_IDENTITY_CHANGED' }); this.name = 'OrderIdentityChangedError'; }
}
function validUser(value: unknown): value is AuthSessionResponse['user'] {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('roles' in value)) return false;
  return typeof value.id === 'string' && value.id.length > 0 && Array.isArray(value.roles) && value.roles.length > 0 && value.roles.every(role => RoleValues.includes(role));
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
  private authentication: Promise<void> | null = null;
  private identityRead = 0;
  onOrderIdentityInvalidated(listener: () => void) { return this.session.onIdentityInvalidated(listener); }

  constructor(
    private readonly baseUrl: string,
    private readonly session: Session,
    private readonly request: RequestPort = (options) =>
      Taro.request(options as Taro.request.Option) as Promise<RequestResult>,
  ) {}

  async authenticate(identityProvider: IdentityCodeProvider): Promise<void> {
    this.identityProvider = identityProvider;
    if (this.session.getAccessToken()) return;
    await this.refreshSession(this.session.getAccessToken());
  }

  private refreshSession(rejectedToken: string | null): Promise<void> {
    if (this.authentication) return this.authentication;
    const currentToken = this.session.getAccessToken();
    if (currentToken !== null && currentToken !== rejectedToken) return Promise.resolve();
    if (!this.identityProvider) return Promise.reject(new Error('Customer authentication is required.'));
    const starting = this.session.getIdentity();
    this.authentication = this.createSession(this.identityProvider).catch(cause => {
      const current = this.session.getIdentity();
      if (starting.epoch === current.epoch && starting.credentialRevision === current.credentialRevision) this.session.clear();
      throw cause;
    }).finally(() => { this.authentication = null; });
    return this.authentication;
  }

  private async createSession(identityProvider: IdentityCodeProvider): Promise<void> {
    const starting = this.session.getIdentity();
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
    const current = this.session.getIdentity();
    if (starting.epoch !== current.epoch || starting.credentialRevision !== current.credentialRevision) throw new OrderIdentityChangedError();
    this.session.setAccessToken(response.accessToken, response.expiresIn, validUser(response.user) ? response.user.id : null);
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

  async getMe(): Promise<{ id: string; roles: Role[] }> {
    const read = ++this.identityRead; const starting = this.session.getIdentity();
    const me = await this.authorized<unknown>('/api/me', 'GET', undefined, {}, true);
    if (read !== this.identityRead) throw new OrderIdentityChangedError();
    if (!validUser(me)) { this.session.bindIdentity(null); throw new OrderIdentityChangedError(); }
    if (starting.epoch !== this.session.getIdentity().epoch && this.session.getIdentity().actorId !== me.id) throw new OrderIdentityChangedError();
    this.session.bindIdentity(me.id);
    return me;
  }

  // Dedicated composition seam; validation and logical keys belong to OrderApi.
  async orderRequest(path: OrderRequestPath, method: 'GET' | 'POST', data?: unknown, key?: string): Promise<unknown> {
    const initiating = this.session.getIdentity();
    const check = () => {
      const current = this.session.getIdentity();
      if (!initiating.actorId || current.actorId !== initiating.actorId || current.epoch !== initiating.epoch) throw new OrderIdentityChangedError();
    };
    check();
    let token = this.session.getAccessToken();
    const execute = () => { check(); token = this.session.getAccessToken(); if (!token) throw new Error('Customer authentication is required.'); return this.send({ url: path, method, data, header: { Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) } }); };
    try {
      if (!token) { await this.refreshSession(token); check(); }
      let result: unknown;
      try { result = await execute(); }
      catch (cause) {
        check();
        if (!(cause instanceof ApiClientError) || cause.statusCode !== 401) throw cause;
        await this.refreshSession(token); check(); result = await execute();
      }
      check(); return result;
    } catch (cause) { check(); throw cause; }
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
      if (!this.identityProvider) throw cause;
      await this.refreshSession(this.session.getAccessToken());
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
