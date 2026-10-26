import {
  ActionGrantViewSchema,
  AdminCaseCommandResultSchema,
  AdminCaseDetailViewSchema,
  AdminCaseListViewSchema,
  CaseEvidenceRequestSchema,
  CaseListQuerySchema,
  CaseRejectSchema,
  ConcludeRiskReportSchema,
  ClearOrderRiskInputSchema,
  OperatorDeviceListResultSchema,
  OperatorLoginResultSchema,
  OperatorSessionListResultSchema,
  OperatorDeviceViewSchema,
  ResolutionAdjudicationSchema,
  ResolutionApprovalSchema,
  ResolutionExecutionSchema,
  ResolutionInputSchema,
  RiskActionInputSchema,
  RiskCommandResultSchema,
  RiskReportCommandSchema,
  RiskReportDetailSchema,
  RiskReportListViewSchema,
  RiskTaskListViewSchema,
  TradingRestrictionViewSchema,
  type ActionGrantView,
  type ApiErrorBody,
  type AdminCaseCommandResult,
  type AdminCaseDetailView,
  type AdminCaseListView,
  type CaseEvidenceRequestInput,
  type CaseListQuery,
  type CaseRejectInput,
  type ClearOrderRiskInput,
  type ConcludeRiskReportInput,
  type OperatorAction,
  type OperatorDeviceListResult,
  type OperatorDeviceView,
  type OperatorLoginResult,
  type OperatorSessionListResult,
  type OperatorSessionView,
  type ResolutionAdjudicationInput,
  type ResolutionApprovalInput,
  type ResolutionExecutionInput,
  type ResolutionInput,
  type RiskActionInput,
  type RiskCommandResult,
  type RiskReportCommand,
  type RiskReportDetail,
  type RiskReportListView,
  type RiskTaskListView,
  type TradingRestrictionView,
} from '@barter/contracts';

import {
  ApiError,
  createApiClient,
  loadStoredSession,
  type AdminApiClient,
  type AuthSession,
  type OperatorUser,
} from './api-client';

const OPERATOR_SESSION_KEY = 'barter-admin-operator-session';
const IDEMPOTENCY_PREFIX = 'admin-as';

type BoundSession = OperatorSessionView;

export type AdminCaseQuery = {
  cursor?: string;
  limit?: number;
  status?: CaseListQuery['status'];
};
export type SensitiveCommandKey = string;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

export async function canonicalRequestHash(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(normalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function operatorBusinessHashInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !['password', 'grantId', 'sessionId', 'operatorAction', 'operatorActionContext'].includes(key),
    ),
  );
}

export function loadBoundOperatorSession(): BoundSession | null {
  const raw = window.sessionStorage.getItem(OPERATOR_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BoundSession;
    if (
      typeof parsed?.id === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.capability === 'string' &&
      typeof parsed.version === 'number'
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  window.sessionStorage.removeItem(OPERATOR_SESSION_KEY);
  return null;
}

function storeBoundOperatorSession(session: BoundSession): void {
  window.sessionStorage.setItem(OPERATOR_SESSION_KEY, JSON.stringify(session));
}

export function clearBoundOperatorSession(): void {
  window.sessionStorage.removeItem(OPERATOR_SESSION_KEY);
}

export interface AdminAfterSalesApi {
  listCases(query?: AdminCaseQuery): Promise<AdminCaseListView>;
  getCase(id: string): Promise<AdminCaseDetailView>;
  requestEvidence(caseId: string, input: CaseEvidenceRequestInput, key: string): Promise<AdminCaseCommandResult>;
  rejectCase(caseId: string, input: CaseRejectInput, key: string): Promise<AdminCaseCommandResult>;
  proposeResolution(caseId: string, input: ResolutionInput, key: string): Promise<AdminCaseCommandResult>;
  adjudicate(caseId: string, input: Omit<ResolutionAdjudicationInput, 'operatorAction'>, password: string, key: string): Promise<AdminCaseCommandResult>;
  approveFunds(caseId: string, input: Omit<ResolutionApprovalInput, 'operatorAction'>, password: string, key: string): Promise<AdminCaseCommandResult>;
  executeFunds(caseId: string, input: Omit<ResolutionExecutionInput, 'operatorAction'>, password: string, key: string): Promise<AdminCaseCommandResult>;
  listReports(query?: { cursor?: string; limit?: number }): Promise<RiskReportListView>;
  getReport(id: string): Promise<RiskReportDetail>;
  listRiskTasks(query?: { cursor?: string; limit?: number }): Promise<RiskTaskListView>;
  claimReport(id: string, input: RiskReportCommand, key: string): Promise<RiskCommandResult>;
  requestReportEvidence(id: string, input: RiskReportCommand, key: string): Promise<RiskCommandResult>;
  concludeReport(id: string, input: ConcludeRiskReportInput, key: string): Promise<RiskCommandResult>;
  getRestriction(userId: string): Promise<TradingRestrictionView>;
  freezeUser(userId: string, input: Omit<RiskActionInput, 'operatorAction'>, password: string, key: string): Promise<RiskCommandResult>;
  unfreezeUser(userId: string, input: Omit<RiskActionInput, 'operatorAction'>, password: string, key: string): Promise<RiskCommandResult>;
  unpublishItem(itemId: string, input: Omit<RiskActionInput, 'operatorAction'>, password: string, key: string): Promise<RiskCommandResult>;
  clearItemRisk(itemId: string, input: Omit<RiskActionInput, 'operatorAction'>, password: string, key: string): Promise<RiskCommandResult>;
  pauseOrder(orderId: string, input: Omit<RiskActionInput, 'operatorAction'>, password: string, key: string): Promise<RiskCommandResult>;
  clearOrderRisk(orderId: string, input: Omit<ClearOrderRiskInput, 'operatorAction'>, password: string, key: string): Promise<RiskCommandResult>;
  clearSensitiveState(): void;
  getIdentityEpoch(): number;
  onIdentityChange(listener: () => void): () => void;
}

export interface OperatorSecurityApi {
  securityLogin(email: string, password: string): Promise<OperatorLoginResult>;
  listDevices(query?: { cursor?: string; limit?: number }): Promise<OperatorDeviceListResult>;
  currentDevice(): Promise<OperatorDeviceView>;
  listSessions(query?: { cursor?: string; limit?: number }): Promise<OperatorSessionListResult>;
  revokeSession(id: string, input: { expectedVersion: number; reason: string }, key: string): Promise<unknown>;
  issueGrant(
    action: OperatorAction,
    resourceId: string,
    expectedVersions: Record<string, number>,
    businessBody: Record<string, unknown>,
    password: string,
  ): Promise<ActionGrantView>;
  clearSensitiveState(): void;
  getBoundSession(): BoundSession | null;
}

type RequestFn = <T>(path: string, init?: RequestInit, authenticated?: boolean) => Promise<T>;

function createRequest(client: AdminApiClient & { request?: RequestFn }, fetchImpl: typeof fetch, baseUrl: string): RequestFn {
  if (typeof client.request === 'function') return client.request.bind(client) as RequestFn;
  return async <T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> => {
    const stored = authenticated ? loadStoredSession() : null;
    if (authenticated && !stored) {
      window.sessionStorage.removeItem('barter-admin-session');
      window.dispatchEvent(new Event('barter:auth-expired'));
      throw new ApiError(401, { code: 'AUTH_REQUIRED', message: '请重新登录', requestId: '' });
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    if (stored) headers.Authorization = `Bearer ${stored.accessToken}`;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    const contentType = response.headers.get('content-type');
    const body = contentType?.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      const fallback =
        response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : 'VALIDATION_FAILED';
      const errorBody: ApiErrorBody =
        body && typeof body === 'object' && 'code' in body && 'message' in body && 'requestId' in body
          ? (body as ApiErrorBody)
          : { code: fallback, message: response.statusText || '请求失败', requestId: '' };
      // A missing device binding is not an expired password login. Sensitive
      // routes return REAUTH_REQUIRED while low-risk review/query sessions stay valid.
      if ((response.status === 401 || errorBody.code === 'AUTH_REQUIRED') && errorBody.code !== 'REAUTH_REQUIRED') {
        window.sessionStorage.removeItem('barter-admin-session');
        clearBoundOperatorSession();
        window.dispatchEvent(new Event('barter:auth-expired'));
      }
      throw new ApiError(response.status, errorBody);
    }
    return body as T;
  };
}

function commandKey(parts: string[]): string {
  return `${IDEMPOTENCY_PREFIX}:${parts.join(':')}`;
}

export function createAdminAfterSalesApi(options: {
  client?: AdminApiClient;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
} = {}): AdminAfterSalesApi & OperatorSecurityApi {
  const baseUrl = options.baseUrl ?? '/api';
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const client = options.client ?? createApiClient({ baseUrl, fetchImpl });
  const request = createRequest(client as AdminApiClient & { request?: RequestFn }, fetchImpl, baseUrl);
  let identityEpoch = 0;
  const listeners = new Set<() => void>();
  const pendingKeys = new Map<string, string>();

  function bumpIdentity(): void {
    identityEpoch += 1;
    pendingKeys.clear();
    clearBoundOperatorSession();
    for (const listener of listeners) listener();
  }

  function requireBoundSession(): BoundSession {
    const session = loadBoundOperatorSession();
    if (!session) {
      throw new ApiError(401, { code: 'REAUTH_REQUIRED', message: 'Bound operator session required', requestId: '' });
    }
    return session;
  }

  async function issueGrant(
    action: OperatorAction,
    resourceId: string,
    expectedVersions: Record<string, number>,
    businessBody: Record<string, unknown>,
    password: string,
  ): Promise<ActionGrantView> {
    requireBoundSession();
    const requestHash = await canonicalRequestHash(operatorBusinessHashInput(businessBody));
    // Password is only sent in this transient request body — never stored.
    const grant = ActionGrantViewSchema.parse(
      await request<unknown>('/admin/security/grants', {
        method: 'POST',
        body: JSON.stringify({ action, resourceId, expectedVersions, requestHash, password }),
      }),
    );
    return grant;
  }

  async function withGrant<T>(
    action: OperatorAction,
    resourceId: string,
    expectedVersions: Record<string, number>,
    businessBody: Record<string, unknown>,
    password: string,
    key: string,
    run: (operatorAction: { sessionId: string; grantId: string }, idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    const session = requireBoundSession();
    const logicalKey = key || commandKey([action, resourceId, String(expectedVersions.expectedCaseVersion ?? expectedVersions.expectedVersion ?? 0)]);
    pendingKeys.set(logicalKey, logicalKey);
    const grant = await issueGrant(action, resourceId, expectedVersions, businessBody, password);
    try {
      return await run({ sessionId: session.id, grantId: grant.id }, logicalKey);
    } catch (error) {
      // Keep the same logical command key on recovery; never reuse the spent grant.
      pendingKeys.set(logicalKey, logicalKey);
      throw error;
    }
  }

  const api: AdminAfterSalesApi & OperatorSecurityApi = {
    getIdentityEpoch: () => identityEpoch,
    onIdentityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearSensitiveState: () => bumpIdentity(),
    getBoundSession: () => loadBoundOperatorSession(),

    async securityLogin(email, password) {
      const result = OperatorLoginResultSchema.parse(
        await request<unknown>(
          '/admin/security/login',
          { method: 'POST', body: JSON.stringify({ email, password }) },
          false,
        ),
      );
      const session: AuthSession = {
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        user: result.user as OperatorUser,
      };
      bumpIdentity();
      window.sessionStorage.setItem(
        'barter-admin-session',
        JSON.stringify({
          accessToken: session.accessToken,
          expiresAt: Date.now() + session.expiresIn * 1_000,
          user: session.user,
        }),
      );
      storeBoundOperatorSession(result.operatorSession);
      return result;
    },

    async listDevices(query = {}) {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      return OperatorDeviceListResultSchema.parse(
        await request(`/admin/security/devices${params.size ? `?${params}` : ''}`, { method: 'GET' }),
      );
    },

    async currentDevice() {
      return OperatorDeviceViewSchema.parse(
        await request('/admin/security/devices', { method: 'POST', body: JSON.stringify({}) }),
      );
    },

    async listSessions(query = {}) {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      return OperatorSessionListResultSchema.parse(
        await request(`/admin/security/sessions${params.size ? `?${params}` : ''}`, { method: 'GET' }),
      );
    },

    async revokeSession(id, input, key) {
      return request(`/admin/security/sessions/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(input),
      });
    },

    issueGrant,

    async listCases(query = {}) {
      const parsed = CaseListQuerySchema.parse(query);
      const params = new URLSearchParams();
      if (parsed.cursor) params.set('cursor', parsed.cursor);
      if (parsed.status) params.set('status', parsed.status);
      if (parsed.limit) params.set('limit', String(parsed.limit));
      return AdminCaseListViewSchema.parse(
        await request(`/admin/after-sales${params.size ? `?${params}` : ''}`, { method: 'GET' }),
      );
    },

    async getCase(id) {
      return AdminCaseDetailViewSchema.parse(
        await request(`/admin/after-sales/${encodeURIComponent(id)}`, { method: 'GET' }),
      );
    },

    async requestEvidence(caseId, input, key) {
      const body = CaseEvidenceRequestSchema.parse(input);
      return AdminCaseCommandResultSchema.parse(
        await request(`/admin/after-sales/${encodeURIComponent(caseId)}/request-evidence`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
      );
    },

    async rejectCase(caseId, input, key) {
      const body = CaseRejectSchema.parse(input);
      return AdminCaseCommandResultSchema.parse(
        await request(`/admin/after-sales/${encodeURIComponent(caseId)}/reject`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
      );
    },

    async proposeResolution(caseId, input, key) {
      const body = ResolutionInputSchema.parse(input);
      return AdminCaseCommandResultSchema.parse(
        await request(`/admin/after-sales/${encodeURIComponent(caseId)}/resolutions`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
      );
    },

    async adjudicate(caseId, input, password, key) {
      const expectedVersions = {
        expectedCaseVersion: input.expectedCaseVersion,
        expectedOrderVersion: input.expectedOrderVersion,
        resolutionVersion: input.resolutionVersion,
      };
      return withGrant('ADJUDICATE_RESOLUTION', caseId, expectedVersions, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = ResolutionAdjudicationSchema.parse({ ...input, operatorAction });
        return AdminCaseCommandResultSchema.parse(
          await request(`/admin/after-sales/${encodeURIComponent(caseId)}/adjudication`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async approveFunds(caseId, input, password, key) {
      const expectedVersions = {
        expectedCaseVersion: input.expectedCaseVersion,
        expectedOrderVersion: input.expectedOrderVersion,
        resolutionVersion: input.resolutionVersion,
      };
      return withGrant('APPROVE_FUNDS', caseId, expectedVersions, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = ResolutionApprovalSchema.parse({ ...input, operatorAction });
        return AdminCaseCommandResultSchema.parse(
          await request(`/admin/after-sales/${encodeURIComponent(caseId)}/approvals`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async executeFunds(caseId, input, password, key) {
      const expectedVersions = {
        expectedCaseVersion: input.expectedCaseVersion,
        expectedOrderVersion: input.expectedOrderVersion,
        resolutionVersion: input.resolutionVersion,
      };
      return withGrant('EXECUTE_FUNDS', caseId, expectedVersions, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = ResolutionExecutionSchema.parse({ ...input, operatorAction });
        return AdminCaseCommandResultSchema.parse(
          await request(`/admin/after-sales/${encodeURIComponent(caseId)}/execute`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async listReports(query = {}) {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      return RiskReportListViewSchema.parse(
        await request(`/admin/reports${params.size ? `?${params}` : ''}`, { method: 'GET' }),
      );
    },

    async getReport(id) {
      return RiskReportDetailSchema.parse(
        await request(`/admin/reports/${encodeURIComponent(id)}`, { method: 'GET' }),
      );
    },

    async listRiskTasks(query = {}) {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      return RiskTaskListViewSchema.parse(
        await request(`/admin/risk-tasks${params.size ? `?${params}` : ''}`, { method: 'GET' }),
      );
    },

    async claimReport(id, input, key) {
      const body = RiskReportCommandSchema.parse(input);
      return RiskCommandResultSchema.parse(
        await request(`/admin/reports/${encodeURIComponent(id)}/claim`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
      );
    },

    async requestReportEvidence(id, input, key) {
      const body = RiskReportCommandSchema.parse(input);
      return RiskCommandResultSchema.parse(
        await request(`/admin/reports/${encodeURIComponent(id)}/request-evidence`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
      );
    },

    async concludeReport(id, input, key) {
      const body = ConcludeRiskReportSchema.parse(input);
      return RiskCommandResultSchema.parse(
        await request(`/admin/reports/${encodeURIComponent(id)}/conclude`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
      );
    },

    async getRestriction(userId) {
      return TradingRestrictionViewSchema.parse(
        await request(`/admin/risk/users/${encodeURIComponent(userId)}`, { method: 'GET' }),
      );
    },

    async freezeUser(userId, input, password, key) {
      return withGrant('FREEZE_TRADING', userId, { expectedVersion: input.expectedVersion }, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = RiskActionInputSchema.parse({ ...input, operatorAction });
        return RiskCommandResultSchema.parse(
          await request(`/admin/risk/users/${encodeURIComponent(userId)}/freeze`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async unfreezeUser(userId, input, password, key) {
      return withGrant('UNFREEZE_TRADING', userId, { expectedVersion: input.expectedVersion }, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = RiskActionInputSchema.parse({ ...input, operatorAction });
        return RiskCommandResultSchema.parse(
          await request(`/admin/risk/users/${encodeURIComponent(userId)}/unfreeze`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async unpublishItem(itemId, input, password, key) {
      return withGrant('UNPUBLISH_ITEM', itemId, { expectedVersion: input.expectedVersion }, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = RiskActionInputSchema.parse({ ...input, operatorAction });
        return RiskCommandResultSchema.parse(
          await request(`/admin/risk/items/${encodeURIComponent(itemId)}/unpublish`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async clearItemRisk(itemId, input, password, key) {
      return withGrant('CLEAR_ITEM_RISK', itemId, { expectedVersion: input.expectedVersion }, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = RiskActionInputSchema.parse({ ...input, operatorAction });
        return RiskCommandResultSchema.parse(
          await request(`/admin/risk/items/${encodeURIComponent(itemId)}/clear-block`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async pauseOrder(orderId, input, password, key) {
      return withGrant('HOLD_ORDER', orderId, { expectedVersion: input.expectedVersion }, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = RiskActionInputSchema.parse({ ...input, operatorAction });
        return RiskCommandResultSchema.parse(
          await request(`/admin/risk/orders/${encodeURIComponent(orderId)}/pause`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },

    async clearOrderRisk(orderId, input, password, key) {
      return withGrant('CLEAR_ORDER_RISK', orderId, { expectedVersion: input.expectedVersion }, input as Record<string, unknown>, password, key, async (operatorAction, idempotencyKey) => {
        const body = ClearOrderRiskInputSchema.parse({ ...input, operatorAction });
        return RiskCommandResultSchema.parse(
          await request(`/admin/risk/orders/${encodeURIComponent(orderId)}/clear-block`, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
          }),
        );
      });
    },
  };

  window.addEventListener('barter:auth-expired', () => bumpIdentity());
  return api;
}

export const adminAfterSalesApi = createAdminAfterSalesApi();
