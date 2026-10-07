import {
  ApiErrorCodes,
  ReviewItemSchema,
  OrderListViewSchema,
  OrderViewSchema,
  RoleValues,
  type ApiErrorBody,
  type ItemView,
  type ProposalView,
  type OrderListView,
  type OrderStatus,
  type OrderView,
  type Role,
} from '@barter/contracts';

export interface OperatorUser {
  id: string;
  roles: Role[];
}

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: OperatorUser;
}

interface StoredSession {
  accessToken: string;
  expiresAt: number;
  user: OperatorUser;
}

export interface OperatorItem extends ItemView {
  owner: { id: string; displayName: string | null };
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actor: { id: string; displayName: string | null } | null;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  requestId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface OperatorItemDetail extends OperatorItem {
  auditHistory: AuditEntry[];
}

export type ReviewItemInput =
  | { decision: 'APPROVE'; expectedVersion: number }
  | { decision: 'REJECT'; expectedVersion: number; reason: string };

export interface ReviewApi {
  listPendingItems(): Promise<OperatorItem[]>;
  getReviewItem(itemId: string): Promise<OperatorItemDetail>;
  reviewItem(itemId: string, input: ReviewItemInput): Promise<OperatorItem>;
}

export interface ProposalReadApi {
  listProposals(): Promise<ProposalView[]>;
  getProposal(id: string): Promise<ProposalView>;
}

export interface OrderReadQuery { cursor?: string; status?: OrderStatus; limit?: number }
export interface OrderReadApi {
  listOrders(query: OrderReadQuery): Promise<OrderListView>;
  getOrder(id: string): Promise<OrderView>;
}

export interface AdminApiClient extends ReviewApi, ProposalReadApi, OrderReadApi {
  login(email: string, password: string): Promise<AuthSession>;
  bootstrapSession(): Promise<OperatorUser | null>;
  logout(): void;
}

export class ApiError extends Error {
  readonly code: ApiErrorBody['code'];
  readonly requestId: string;
  readonly details?: unknown;

  constructor(
    readonly status: number,
    body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

const sessionKey = 'barter-admin-session';
const operatorRoles: readonly Role[] = ['OPERATIONS', 'REVIEWER', 'SUPER_ADMIN'];

function isOperatorUser(value: unknown): value is OperatorUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OperatorUser>;
  return (
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.roles) &&
    candidate.roles.length > 0 &&
    candidate.roles.every(
      (role) => RoleValues.includes(role) && operatorRoles.includes(role),
    )
  );
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredSession>;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.expiresAt === 'number' &&
    isOperatorUser(candidate.user)
  );
}

export function loadStoredSession(): StoredSession | null {
  const raw = window.sessionStorage.getItem(sessionKey);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSession(parsed) || parsed.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(sessionKey);
      return null;
    }
    return parsed;
  } catch {
    window.sessionStorage.removeItem(sessionKey);
    return null;
  }
}

function storeSession(session: AuthSession): void {
  const stored: StoredSession = {
    accessToken: session.accessToken,
    expiresAt: Date.now() + session.expiresIn * 1_000,
    user: session.user,
  };
  window.sessionStorage.setItem(sessionKey, JSON.stringify(stored));
}

function clearSessionAndNotify(): void {
  window.sessionStorage.removeItem(sessionKey);
  window.dispatchEvent(new Event('barter:auth-expired'));
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<ApiErrorBody>;
  return (
    typeof body.code === 'string' &&
    ApiErrorCodes.includes(body.code as ApiErrorBody['code']) &&
    typeof body.message === 'string' &&
    typeof body.requestId === 'string'
  );
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) return null;
  return await response.json();
}

export function createApiClient(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): AdminApiClient {
  const baseUrl = options.baseUrl ?? '/api';
  const fetchImpl =
    options.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  let bootstrapFlight: {
    accessToken: string;
    promise: Promise<OperatorUser | null>;
  } | null = null;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<T> {
    const stored = authenticated ? loadStoredSession() : null;
    if (authenticated && !stored) {
      clearSessionAndNotify();
      throw new ApiError(401, {
        code: 'AUTH_REQUIRED',
        message: '请重新登录',
        requestId: '',
      });
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    if (stored) headers.Authorization = `Bearer ${stored.accessToken}`;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    const body = await readBody(response);
    if (!response.ok) {
      const fallbackCode =
        response.status === 401
          ? 'AUTH_REQUIRED'
          : response.status === 403
            ? 'FORBIDDEN'
            : 'VALIDATION_FAILED';
      const errorBody: ApiErrorBody = isApiErrorBody(body)
        ? body
        : {
            code: fallbackCode,
            message: response.statusText || '请求失败',
            requestId: '',
          };
      if (response.status === 401 || errorBody.code === 'AUTH_REQUIRED') {
        clearSessionAndNotify();
      }
      throw new ApiError(response.status, errorBody);
    }
    return body as T;
  }

  return {
    async login(email, password) {
      const session = await request<AuthSession>(
        '/auth/admin/password',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        },
        false,
      );
      if (!isOperatorUser(session.user)) {
        throw new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'Operator permission is required',
          requestId: '',
        });
      }
      storeSession(session);
      return session;
    },

    async bootstrapSession() {
      const stored = loadStoredSession();
      if (!stored) return null;
      if (bootstrapFlight?.accessToken === stored.accessToken) {
        return bootstrapFlight.promise;
      }
      const promise = (async (): Promise<OperatorUser | null> => {
        const user = await request<OperatorUser>('/admin/session');
        if (!isOperatorUser(user)) {
          clearSessionAndNotify();
          return null;
        }
        return user;
      })();
      bootstrapFlight = { accessToken: stored.accessToken, promise };
      try {
        return await promise;
      } finally {
        if (bootstrapFlight?.promise === promise) {
          bootstrapFlight = null;
        }
      }
    },

    logout() {
      window.sessionStorage.removeItem(sessionKey);
    },

    listPendingItems() {
      return request<OperatorItem[]>('/admin/items?status=PENDING_REVIEW');
    },

    listProposals() {
      return request<ProposalView[]>('/admin/proposals');
    },

    getProposal(id) {
      return request<ProposalView>(`/admin/proposals/${encodeURIComponent(id)}`);
    },

    async listOrders(query) {
      const params = new URLSearchParams();
      if (query.status !== undefined) params.set('status', query.status);
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return OrderListViewSchema.parse(await request<unknown>(`/admin/orders${params.size ? `?${params}` : ''}`, { method: 'GET' }));
    },

    async getOrder(id) {
      return OrderViewSchema.parse(await request<unknown>(`/admin/orders/${encodeURIComponent(id)}`, { method: 'GET' }));
    },

    getReviewItem(itemId) {
      return request<OperatorItemDetail>(`/admin/items/${encodeURIComponent(itemId)}`);
    },

    reviewItem(itemId, input) {
      const body = ReviewItemSchema.parse(input) as ReviewItemInput;
      return request<OperatorItem>(
        `/admin/items/${encodeURIComponent(itemId)}/reviews`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
  };
}

export const apiClient = createApiClient();
