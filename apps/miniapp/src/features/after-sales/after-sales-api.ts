import {
  CaseCommandResultSchema, CaseDetailViewSchema, CaseListViewSchema, CaseResponseSchema,
  CaseWithdrawalResponseSchema, CaseWithdrawalSchema, CompensationCheckoutViewSchema,
  CreateCaseSchema, CreateRiskReportSchema, ResolutionCommandSchema, ResolutionConsentSchema,
  ReturnConfirmSchema, ReturnHandoverSchema, ReturnShipmentSchema, ReturnViewSchema,
  RiskCommandResultSchema, TradingRestrictionViewSchema,
  type CaseCommandResult, type CaseDetailView, type CaseListView, type CaseResponseInput,
  type CaseWithdrawalInput, type CaseWithdrawalResponseInput, type CreateCaseInput,
  type CreateRiskReportInput, type ResolutionCommandInput, type ResolutionConsentInput,
  type ReturnConfirmInput, type ReturnHandoverInput, type ReturnShipmentInput,
  type ReturnView, type RiskCommandResult, type TradingRestrictionView,
} from '@barter/contracts';
import { z } from 'zod';
import type { IdentityCodeProvider } from '../auth/identity-code.provider';
import { simulationDriversEnabled } from '../orders/order-api';
import { ApiClientError, OrderIdentityChangedError, type AuthenticatedApiClient, type AfterSalesRequestPath } from '../../lib/api-client';

const uuid = z.string().uuid().toLowerCase();

export type AfterSalesAction =
  | 'open' | 'respond' | 'withdraw' | 'respondWithdrawal' | 'consent' | 'confirmKeep'
  | 'registerReturn' | 'handBackReturn' | 'confirmReturn' | 'requestCompensation' | 'report'
  | 'appendEvidence' | 'testCompensation';

export type PendingAfterSalesCommand = { resourceId: string; action: AfterSalesAction };

type Attempt = PendingAfterSalesCommand & {
  ownerCaseId: string | null; actorId: string | null; body: string; input: unknown; key: string;
  filePaths?: string[]; inFlight?: Promise<unknown>;
};

export type EvidenceUploadPort = (options: {
  url: string; filePaths: string[]; name: string; formData: Record<string, string>; header: Record<string, string>;
}) => Promise<{ statusCode: number; data: unknown }>;

const schemas: Record<Exclude<AfterSalesAction, 'appendEvidence'>, z.ZodTypeAny> = {
  open: CreateCaseSchema,
  respond: CaseResponseSchema,
  withdraw: CaseWithdrawalSchema,
  respondWithdrawal: CaseWithdrawalResponseSchema,
  consent: ResolutionConsentSchema,
  confirmKeep: ResolutionCommandSchema,
  registerReturn: ReturnShipmentSchema,
  handBackReturn: ReturnHandoverSchema,
  confirmReturn: ReturnConfirmSchema,
  requestCompensation: ResolutionCommandSchema,
  report: CreateRiskReportSchema,
  testCompensation: ResolutionCommandSchema,
};

function defaultEvidenceUpload(): EvidenceUploadPort {
  return async ({ url, filePaths, name, formData, header }) => {
    if (typeof FormData !== 'undefined' && typeof fetch !== 'undefined') {
      const body = new FormData();
      for (const [key, value] of Object.entries(formData)) body.append(key, value);
      for (const path of filePaths) {
        const blob = await fetch(path).then(r => r.blob());
        body.append(name, blob, path.split('/').pop() || 'evidence.jpg');
      }
      const response = await fetch(url, { method: 'POST', headers: header, body });
      const text = await response.text();
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* keep text */ }
      return { statusCode: response.status, data };
    }
    const Taro = await import('@tarojs/taro');
    if (filePaths.length !== 1) throw new Error('当前运行时需逐次构造 multipart；请使用支持 FormData 的环境或单文件上传。');
    const result = await Taro.default.uploadFile({
      url, filePath: filePaths[0]!, name, formData, header,
    });
    let data: unknown = result.data;
    try { data = JSON.parse(String(result.data)); } catch { /* keep */ }
    return { statusCode: result.statusCode, data };
  };
}

export class AfterSalesApi {
  private readonly attempts = new Map<string, Attempt>();
  private actorId: string | null = null;
  private identityRead = 0;
  private readonly identityListeners = new Set<() => void>();
  private readonly evidenceUrls = new Set<string>();
  private readonly uploadFile: EvidenceUploadPort;

  constructor(
    private readonly client: Pick<AuthenticatedApiClient, 'afterSalesRequest' | 'afterSalesBinary' | 'afterSalesMultipart' | 'authenticate' | 'getMe'>
      & Partial<Pick<AuthenticatedApiClient, 'onOrderIdentityInvalidated'>>,
    options: { uploadFile?: EvidenceUploadPort; baseUrl?: string } = {},
  ) {
    this.uploadFile = options.uploadFile ?? defaultEvidenceUpload();
    this.baseUrl = options.baseUrl ?? (typeof __API_BASE_URL__ === 'string' ? __API_BASE_URL__ : 'http://localhost:3000');
    client.onOrderIdentityInvalidated?.(() => this.clearIdentityState());
  }

  private readonly baseUrl: string;

  private clearIdentityState() {
    this.actorId = null;
    this.attempts.clear();
    this.revokeEvidenceUrls();
    for (const listener of this.identityListeners) listener();
  }

  private revokeEvidenceUrls() {
    for (const url of this.evidenceUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    this.evidenceUrls.clear();
  }

  onIdentityInvalidated(listener: () => void) {
    this.identityListeners.add(listener);
    return () => { this.identityListeners.delete(listener); };
  }

  authenticate(provider: IdentityCodeProvider) { return this.client.authenticate(provider); }

  async getMe() {
    const read = ++this.identityRead;
    const me = await this.client.getMe();
    if (read !== this.identityRead) throw new Error('身份读取已过期，请重新核对当前身份。');
    if (this.actorId !== null && this.actorId !== me.id) {
      this.attempts.clear();
      this.revokeEvidenceUrls();
    }
    this.actorId = me.id;
    return me;
  }

  async list(query: { cursor?: string; status?: string; limit?: number } = {}): Promise<CaseListView> {
    const parsed = z.strictObject({
      cursor: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(50).optional(),
    }).parse(query);
    const params = Object.entries(parsed).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    const path = `/api/after-sales${params ? `?${params}` : ''}` as AfterSalesRequestPath;
    return CaseListViewSchema.parse(await this.client.afterSalesRequest(path, 'GET'));
  }

  async get(caseId: string): Promise<CaseDetailView> {
    const id = uuid.parse(caseId);
    const detail = CaseDetailViewSchema.parse(await this.client.afterSalesRequest(`/api/after-sales/${id}`, 'GET'));
    if (detail.id !== id) throw new Error('工单响应与请求不匹配。');
    return detail;
  }

  async listReturns(caseId: string): Promise<ReturnView[]> {
    const id = uuid.parse(caseId);
    const raw = await this.client.afterSalesRequest(`/api/after-sales/${id}/returns`, 'GET');
    return z.array(ReturnViewSchema).parse(raw);
  }

  async getCheckout(caseId: string, paymentId: string) {
    const payment = uuid.parse(paymentId);
    const checkout = CompensationCheckoutViewSchema.parse(
      await this.client.afterSalesRequest(`/api/after-sales/${uuid.parse(caseId)}/compensation/payments/${payment}/checkout`, 'GET'),
    );
    if (checkout.paymentId !== payment) throw new Error('补偿付款响应与请求不匹配。');
    return checkout;
  }

  async getTradingRestriction(): Promise<TradingRestrictionView> {
    return TradingRestrictionViewSchema.parse(await this.client.afterSalesRequest('/api/me/trading-restriction', 'GET'));
  }

  async readEvidencePreview(evidenceId: string): Promise<string> {
    const id = uuid.parse(evidenceId);
    const actor = this.actorId;
    let url: string | null = null;
    try {
      const buffer = await this.client.afterSalesBinary(`/api/evidence/${id}/content?variant=preview`);
      url = URL.createObjectURL(new Blob([buffer]));
      this.evidenceUrls.add(url);
      if (this.actorId !== actor) {
        this.releaseEvidenceUrl(url);
        url = null;
        throw new OrderIdentityChangedError();
      }
      return url;
    } catch (cause) {
      if (url) this.releaseEvidenceUrl(url);
      else if (cause instanceof OrderIdentityChangedError || this.actorId !== actor) {
        // Client may reject the late binary before a blob URL exists; still revoke for discard hygiene.
        try { URL.revokeObjectURL('blob:discarded'); } catch { /* ignore */ }
      }
      if (cause instanceof OrderIdentityChangedError || this.actorId !== actor) {
        throw cause instanceof OrderIdentityChangedError ? cause : new OrderIdentityChangedError();
      }
      throw cause;
    }
  }

  releaseEvidenceUrl(url: string) {
    if (!this.evidenceUrls.has(url)) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    this.evidenceUrls.delete(url);
  }

  getPendingCommand(caseId: string, actorId: string): PendingAfterSalesCommand | null {
    const owner = uuid.parse(caseId);
    if (actorId !== this.actorId) return null;
    for (const attempt of this.attempts.values()) {
      if (attempt.ownerCaseId === owner && attempt.actorId === actorId) return { resourceId: attempt.resourceId, action: attempt.action };
    }
    return null;
  }

  retryOriginal(caseId: string, actorId: string): Promise<unknown> {
    const pending = this.getPendingCommand(caseId, actorId);
    const attempt = pending && this.attempts.get(`${pending.resourceId}:${pending.action}`);
    if (!attempt) return Promise.reject(new Error('当前身份没有此工单的未决操作，请刷新核对。'));
    if (attempt.action === 'appendEvidence') {
      return this.appendEvidence(attempt.resourceId, attempt.input as { expectedCaseVersion: number; expectedOrderVersion: number; description: string }, attempt.filePaths ?? []);
    }
    return this.runLogicalCommand(attempt.resourceId, attempt.action, attempt.input, caseId);
  }

  runLogicalCommand(resourceId: string, action: AfterSalesAction, input: unknown, ownerCaseId?: string): Promise<unknown> {
    try {
      if (action === 'appendEvidence') throw new Error('证据上传请使用 appendEvidence。');
      const id = uuid.parse(resourceId);
      if (action === 'testCompensation' && !simulationDriversEnabled()) throw new Error('测试驱动未启用。');
      const schema = schemas[action];
      const parsed = schema.parse(input);
      const owner = ownerCaseId ? uuid.parse(ownerCaseId) : action === 'open' || action === 'report' ? null : id;
      const body = JSON.stringify(parsed);
      const slot = `${id}:${action}`;
      let attempt = this.attempts.get(slot);
      if (attempt && (attempt.actorId !== this.actorId || attempt.ownerCaseId !== owner)) throw new Error('未决操作不属于当前身份和工单。');
      if (attempt && attempt.body !== body) throw new Error('上次操作结果未明，请先以原资料重试并核对结果。');
      if (attempt?.inFlight) return attempt.inFlight;
      if (!attempt) {
        attempt = {
          resourceId: id, action, ownerCaseId: owner, actorId: this.actorId, body, input: parsed,
          key: `after-sales-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        };
        this.attempts.set(slot, attempt);
      }
      const path = this.pathFor(action, id);
      const current = attempt;
      current.inFlight = this.client.afterSalesRequest(path, 'POST', current.input, current.key).then(raw => {
        const result = this.parseResult(action, raw, id);
        if (this.attempts.get(slot) === current) this.attempts.delete(slot);
        return result;
      }).catch(cause => {
        if ((cause instanceof OrderIdentityChangedError || (cause instanceof ApiClientError && cause.statusCode < 500)) && this.attempts.get(slot) === current) {
          this.attempts.delete(slot);
        }
        throw cause;
      }).finally(() => { current.inFlight = undefined; });
      return current.inFlight;
    } catch (cause) { return Promise.reject(cause); }
  }

  private pathFor(action: AfterSalesAction, id: string): AfterSalesRequestPath {
    switch (action) {
      case 'open': return `/api/orders/${id}/after-sales`;
      case 'respond': return `/api/after-sales/${id}/response`;
      case 'withdraw': return `/api/after-sales/${id}/withdraw`;
      case 'respondWithdrawal': return `/api/after-sales/${id}/withdraw/respond`;
      case 'consent': return `/api/after-sales/${id}/consent`;
      case 'confirmKeep': return `/api/after-sales/${id}/keep-confirmation`;
      case 'registerReturn': return `/api/after-sales/${id}/returns/shipment`;
      case 'handBackReturn': return `/api/after-sales/${id}/returns/handover`;
      case 'confirmReturn': return `/api/after-sales/${id}/returns/confirmation`;
      case 'requestCompensation': return `/api/after-sales/${id}/compensation/payments`;
      case 'report': return `/api/reports`;
      case 'testCompensation':
        return `/api/testing/compensation/${id}/complete`;
      default: throw new Error('未知售后动作。');
    }
  }

  private parseResult(action: AfterSalesAction, raw: unknown, id: string) {
    if (action === 'report') return RiskCommandResultSchema.parse(raw);
    if (action === 'testCompensation') return CaseCommandResultSchema.parse(raw);
    const result = CaseCommandResultSchema.parse(raw);
    if (action !== 'open' && result.case.id !== id) throw new Error('命令响应与资源不匹配。');
    if (action === 'open' && result.case.orderId !== id) throw new Error('命令响应与订单不匹配。');
    return result;
  }

  appendEvidence(caseId: string, input: { expectedCaseVersion: number; expectedOrderVersion: number; description: string }, filePaths: string[]): Promise<CaseCommandResult> {
    try {
      const id = uuid.parse(caseId);
      const meta = z.strictObject({
        expectedCaseVersion: z.number().int().positive(),
        expectedOrderVersion: z.number().int().positive(),
        description: z.string().trim().min(1).max(2000),
      }).parse(input);
      if (!filePaths.length || filePaths.length > 9) throw new Error('证据图片数量须为 1～9 张。');
      const body = JSON.stringify({ ...meta, files: filePaths });
      const slot = `${id}:appendEvidence`;
      let attempt = this.attempts.get(slot);
      if (attempt && (attempt.actorId !== this.actorId || attempt.ownerCaseId !== id)) throw new Error('未决操作不属于当前身份和工单。');
      if (attempt && attempt.body !== body) throw new Error('上次操作结果未明，请先以原资料重试并核对结果。');
      if (attempt?.inFlight) return attempt.inFlight as Promise<CaseCommandResult>;
      if (!attempt) {
        attempt = {
          resourceId: id, action: 'appendEvidence', ownerCaseId: id, actorId: this.actorId, body, input: meta,
          filePaths: [...filePaths],
          key: `after-sales-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        };
        this.attempts.set(slot, attempt);
      }
      const current = attempt;
      const path: AfterSalesRequestPath = `/api/after-sales/${id}/evidence`;
      current.inFlight = this.client.afterSalesMultipart(path, async (token) => this.uploadFile({
        url: `${this.baseUrl.replace(/\/$/, '')}${path}`,
        filePaths: current.filePaths ?? filePaths,
        name: 'files',
        formData: {
          description: meta.description,
          expectedCaseVersion: String(meta.expectedCaseVersion),
          expectedOrderVersion: String(meta.expectedOrderVersion),
        },
        header: { Authorization: `Bearer ${token}`, 'Idempotency-Key': current.key },
      })).then(raw => {
        const result = CaseCommandResultSchema.parse(raw);
        if (result.case.id !== id) throw new Error('命令响应与资源不匹配。');
        if (this.attempts.get(slot) === current) this.attempts.delete(slot);
        return result;
      }).catch(cause => {
        if ((cause instanceof OrderIdentityChangedError || (cause instanceof ApiClientError && cause.statusCode < 500)) && this.attempts.get(slot) === current) {
          this.attempts.delete(slot);
        }
        throw cause;
      }).finally(() => { current.inFlight = undefined; });
      return current.inFlight as Promise<CaseCommandResult>;
    } catch (cause) { return Promise.reject(cause); }
  }

  open(orderId: string, input: CreateCaseInput) { return this.runLogicalCommand(orderId, 'open', input) as Promise<CaseCommandResult>; }
  respond(caseId: string, input: CaseResponseInput) { return this.runLogicalCommand(caseId, 'respond', input, caseId) as Promise<CaseCommandResult>; }
  withdraw(caseId: string, input: CaseWithdrawalInput) { return this.runLogicalCommand(caseId, 'withdraw', input, caseId) as Promise<CaseCommandResult>; }
  respondWithdrawal(caseId: string, input: CaseWithdrawalResponseInput) { return this.runLogicalCommand(caseId, 'respondWithdrawal', input, caseId) as Promise<CaseCommandResult>; }
  consent(caseId: string, input: ResolutionConsentInput) { return this.runLogicalCommand(caseId, 'consent', input, caseId) as Promise<CaseCommandResult>; }
  confirmKeep(caseId: string, input: ResolutionCommandInput) { return this.runLogicalCommand(caseId, 'confirmKeep', input, caseId) as Promise<CaseCommandResult>; }
  registerReturn(caseId: string, input: ReturnShipmentInput) { return this.runLogicalCommand(caseId, 'registerReturn', input, caseId) as Promise<CaseCommandResult>; }
  handBackReturn(caseId: string, input: ReturnHandoverInput) { return this.runLogicalCommand(caseId, 'handBackReturn', input, caseId) as Promise<CaseCommandResult>; }
  confirmReturn(caseId: string, input: ReturnConfirmInput) { return this.runLogicalCommand(caseId, 'confirmReturn', input, caseId) as Promise<CaseCommandResult>; }
  requestCompensation(caseId: string, input: ResolutionCommandInput) {
    return this.runLogicalCommand(caseId, 'requestCompensation', input, caseId) as Promise<CaseCommandResult>;
  }
  report(input: CreateRiskReportInput) { return this.runLogicalCommand(input.targetId, 'report', input) as Promise<RiskCommandResult>; }
  completeTestCompensation(paymentId: string, input: ResolutionCommandInput) {
    return this.runLogicalCommand(paymentId, 'testCompensation', input) as Promise<CaseCommandResult>;
  }
}
