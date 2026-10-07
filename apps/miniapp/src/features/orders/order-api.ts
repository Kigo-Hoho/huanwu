import {
  CheckoutViewSchema, OrderAddressSchema, OrderAddressViewSchema, OrderCancellationSchema,
  OrderCancellationRespondSchema, OrderCancellationWithdrawSchema, OrderCommandSchema,
  OrderCommandResultSchema, OrderIssueSchema, OrderListViewSchema, OrderPaymentSchema,
  OrderShipmentSchema, OrderStatusSchema, OrderViewSchema,
  type OrderAddressInput, type OrderCancellationInput, type OrderCancellationRespondInput,
  type OrderCancellationWithdrawInput, type OrderCommandInput, type OrderCommandResult,
  type OrderIssueInput, type OrderPaymentInput, type OrderShipmentInput, type OrderStatus,
} from '@barter/contracts';
import { z } from 'zod';
import type { IdentityCodeProvider } from '../auth/identity-code.provider';
import { ApiClientError, type AuthenticatedApiClient, type OrderRequestPath } from '../../lib/api-client';

const uuid = z.string().uuid().toLowerCase();
const schemas = {
  convert: OrderCommandSchema, address: OrderAddressSchema, payment: OrderPaymentSchema,
  shipment: OrderShipmentSchema, handover: OrderCommandSchema, acceptance: OrderCommandSchema,
  issue: OrderIssueSchema, cancellation: OrderCancellationSchema,
  respondCancellation: OrderCancellationRespondSchema, withdrawCancellation: OrderCancellationWithdrawSchema,
  testPayment: OrderCommandSchema,
  testShipment: OrderCommandSchema.extend({ progress: z.enum(['COLLECTED', 'DELIVERED', 'EXCEPTION']) }).strict(),
};
export type OrderAction = keyof typeof schemas;
const suffix = { address: 'address', payment: 'payments', shipment: 'shipments', handover: 'handover', acceptance: 'acceptance', issue: 'issue', cancellation: 'cancellation', respondCancellation: 'cancellation/respond', withdrawCancellation: 'cancellation/withdraw' };
export type PendingOrderCommand = { resourceId: string; action: OrderAction };
type Attempt = PendingOrderCommand & { ownerOrderId: string | null; actorId: string | null; body: string; input: unknown; key: string; inFlight?: Promise<OrderCommandResult> };

export function simulationDriversEnabled(): boolean {
  return typeof __INTEGRATION_MODE__ === 'string' && __INTEGRATION_MODE__ === 'simulated' &&
    typeof __BUILD_ENVIRONMENT__ === 'string' &&
    (__BUILD_ENVIRONMENT__ === 'development' || (__BUILD_ENVIRONMENT__ === 'acceptance' &&
      typeof __TARO_TARGET__ === 'string' && __TARO_TARGET__ === 'h5' &&
      typeof __IDENTITY_PROVIDER__ === 'string' && __IDENTITY_PROVIDER__ === 'acceptance'));
}

export class OrderApi {
  // Only unresolved logical commands live here. No response or private GET cache.
  private readonly attempts = new Map<string, Attempt>();
  private actorId: string | null = null;
  private identityRead = 0;
  constructor(private readonly client: Pick<AuthenticatedApiClient, 'orderRequest' | 'authenticate' | 'getMe'>) {}
  authenticate(provider: IdentityCodeProvider) { return this.client.authenticate(provider); }
  async getMe() {
    const read = ++this.identityRead;
    const me = await this.client.getMe();
    if (read !== this.identityRead) throw new Error('身份读取已过期，请重新核对当前身份。');
    if (this.actorId !== null && this.actorId !== me.id) this.attempts.clear();
    this.actorId = me.id;
    return me;
  }
  async listMyOrders(query: { cursor?: string; status?: OrderStatus; limit?: number } = {}) {
    const parsed = z.strictObject({ cursor: z.string().optional(), status: OrderStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).parse(query);
    const params = Object.entries(parsed).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
    return OrderListViewSchema.parse(await this.client.orderRequest(`/api/me/orders${params ? '?' + params : ''}`, 'GET'));
  }
  async getOrder(id: string) {
    const resource = uuid.parse(id);
    const order = OrderViewSchema.parse(await this.client.orderRequest(`/api/orders/${resource}`, 'GET'));
    if (order.id !== resource) throw new Error('订单响应与请求不匹配。');
    return order;
  }
  async getShippingAddress(id: string, side: 'self' | 'outgoing') {
    const resource = uuid.parse(id); const selection = z.enum(['self', 'outgoing']).parse(side);
    const address = OrderAddressViewSchema.parse(await this.client.orderRequest(`/api/orders/${resource}/shipping-address?side=${selection}`, 'GET'));
    if (address.orderId !== resource) throw new Error('资料响应与订单不匹配。');
    return address;
  }
  async getCheckout(id: string, intentId: string) {
    const intent = uuid.parse(intentId);
    const checkout = CheckoutViewSchema.parse(await this.client.orderRequest(`/api/orders/${uuid.parse(id)}/payments/${intent}/checkout`, 'GET'));
    if (checkout.paymentIntentId !== intent) throw new Error('付款响应与请求不匹配。');
    return checkout;
  }
  getPendingCommand(orderId: string, actorId: string): PendingOrderCommand | null {
    const owner = uuid.parse(orderId);
    if (actorId !== this.actorId) return null;
    for (const attempt of this.attempts.values()) {
      if (attempt.ownerOrderId === owner && attempt.actorId === actorId) return { resourceId: attempt.resourceId, action: attempt.action };
    }
    return null;
  }
  retryOriginal(orderId: string, actorId: string): Promise<OrderCommandResult> {
    const pending = this.getPendingCommand(orderId, actorId);
    const attempt = pending && this.attempts.get(`${pending.resourceId}:${pending.action}`);
    if (!attempt) return Promise.reject(new Error('当前身份没有此订单的未决操作，请刷新核对。'));
    return this.runLogicalCommand(attempt.resourceId, attempt.action, attempt.input, orderId);
  }
  runLogicalCommand(resourceId: string, action: OrderAction, input: unknown, ownerOrderId?: string): Promise<OrderCommandResult> {
    try {
      const id = uuid.parse(resourceId);
      const schema = schemas[action]; if (!schema) throw new Error('未知订单动作。');
      if ((action === 'testPayment' || action === 'testShipment') && !simulationDriversEnabled()) throw new Error('测试驱动未启用。');
      const parsed = schema.parse(input);
      const owner = ownerOrderId ? uuid.parse(ownerOrderId) : action.startsWith('test') || action === 'convert' ? null : id;
      const body = JSON.stringify(parsed); const slot = `${id}:${action}`;
      let attempt = this.attempts.get(slot);
      if (attempt && (attempt.actorId !== this.actorId || attempt.ownerOrderId !== owner)) throw new Error('未决操作不属于当前身份和订单。');
      if (attempt && attempt.body !== body) throw new Error('上次操作结果未明，请先以原资料重试并核对结果。');
      if (attempt?.inFlight) return attempt.inFlight;
      if (!attempt) {
        attempt = { resourceId: id, action, ownerOrderId: owner, actorId: this.actorId, body, input: parsed, key: `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
        this.attempts.set(slot, attempt);
      }
      const path: OrderRequestPath = action === 'convert' ? `/api/proposals/${id}/order`
        : action === 'testPayment' ? `/api/testing/payments/${id}/complete`
          : action === 'testShipment' ? `/api/testing/shipments/${id}/progress` : `/api/orders/${id}/${suffix[action]}`;
      const current = attempt;
      current.inFlight = this.client.orderRequest(path, 'POST', current.input, current.key).then(raw => {
        const result = OrderCommandResultSchema.parse(raw);
        if (action === 'convert' ? result.order.proposalId !== id : !action.startsWith('test') && result.order.id !== id) throw new Error('命令响应与资源不匹配。');
        if (this.attempts.get(slot) === current) this.attempts.delete(slot); // Release successful address plaintext immediately.
        return result;
      }).catch(cause => {
        if (cause instanceof ApiClientError && cause.statusCode < 500 && this.attempts.get(slot) === current) this.attempts.delete(slot);
        throw cause;
      }).finally(() => { current.inFlight = undefined; });
      return current.inFlight;
    } catch (cause) { return Promise.reject(cause); }
  }
  convertProposal(id: string, input: OrderCommandInput) { return this.runLogicalCommand(id, 'convert', input); }
  saveAddress(id: string, input: OrderAddressInput) { return this.runLogicalCommand(id, 'address', input); }
  startPayment(id: string, input: OrderPaymentInput) { return this.runLogicalCommand(id, 'payment', input); }
  submitShipment(id: string, input: OrderShipmentInput) { return this.runLogicalCommand(id, 'shipment', input); }
  confirmHandover(id: string, input: OrderCommandInput) { return this.runLogicalCommand(id, 'handover', input); }
  acceptOrder(id: string, input: OrderCommandInput) { return this.runLogicalCommand(id, 'acceptance', input); }
  reportIssue(id: string, input: OrderIssueInput) { return this.runLogicalCommand(id, 'issue', input); }
  requestCancellation(id: string, input: OrderCancellationInput) { return this.runLogicalCommand(id, 'cancellation', input); }
  respondCancellation(id: string, input: OrderCancellationRespondInput) { return this.runLogicalCommand(id, 'respondCancellation', input); }
  withdrawCancellation(id: string, input: OrderCancellationWithdrawInput) { return this.runLogicalCommand(id, 'withdrawCancellation', input); }
}
