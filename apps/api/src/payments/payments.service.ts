import { createHmac, randomUUID } from 'node:crypto';
import { CheckoutViewSchema, OrderCommandResultSchema, type CheckoutView, type OrderCommandInput, type OrderPaymentInput, type OrderCommandResult } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer } from '../auth/customer-only.guard.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { INTEGRATION_CONFIG, integrationUnavailable, type IntegrationConfiguration } from '../integrations/integration-config.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { OrderCommandsService, assertOrderParticipant, orderRequestHash, replayOrderCommand } from '../orders/order-commands.service.js';
import { readOrder } from '../orders/order-reader.js';
import { PAYMENT_PORT, type PaymentPort } from './payment.port.js';
import { PaymentEventsService } from './payment-events.service.js';
import { SimulatedProviderStore } from '../integrations/simulated-provider.store.js';
import { SimulatedPaymentAdapter } from '../integrations/simulated-payment.adapter.js';
import { mapOrder } from '../orders/order.mapper.js';
import type { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(OrderCommandsService) private readonly commands: OrderCommandsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PAYMENT_PORT) private readonly port: PaymentPort,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PaymentEventsService) private readonly events: PaymentEventsService,
    @Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore,
    @Inject(SimulatedPaymentAdapter) private readonly adapter: SimulatedPaymentAdapter,
  ) {}
  start(actor: AuthenticatedUser, id: string, input: OrderPaymentInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'START_ORDER_PAYMENT' }, async (tx, order) => {
      if (this.config.payment === 'disabled') throw integrationUnavailable();
      if (order.status === 'AWAITING_DETAILS') throw new ConflictException({ code: 'ORDER_DETAILS_REQUIRED', message: 'Both shipping addresses are required' });
      if (order.status !== 'AWAITING_PAYMENT') throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order is not awaiting payment' });
      const side = order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      if (input.purpose === 'DIFFERENCE') {
        if (order.differenceFen === 0) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order has no difference obligation' });
        if (order.payer !== side) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This difference belongs to the other participant' });
      }
      let intent = await tx.paymentIntent.findUnique({ where: { orderId_side_purpose: { orderId: id, side, purpose: input.purpose } } });
      if (!intent) {
        const intentId = randomUUID();
        intent = await tx.paymentIntent.create({ data: { id: intentId, orderId: id, side, purpose: input.purpose, amountFen: input.purpose === 'DEPOSIT' ? order.depositFen : order.differenceFen, currency: 'CNY', provider: this.config.payment, businessNo: `payment:${intentId}` } });
        await this.outbox.enqueue(tx, { orderId: id, businessNo: intent.businessNo, kind: 'CREATE_PAYMENT', payload: { amountFen: intent.amountFen, currency: 'CNY' } });
      }
      return { auditAction: 'ORDER_PAYMENT_STARTED', paymentIntentId: intent.id };
    });
  }
  async checkout(actor: AuthenticatedUser, id: string, intentId: string): Promise<CheckoutView> {
    assertPureCustomer(actor);
    const authorize = () => this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id}::uuid FOR UPDATE`;
      const order = await readOrder(tx, id); assertOrderParticipant(order, actor.id);
      const intent = await tx.paymentIntent.findUnique({ where: { id: intentId } });
      if (!intent || intent.orderId !== id) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Payment was not found' });
      if ((intent.side === 'INITIATOR' ? order.initiatorId : order.recipientId) !== actor.id) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Checkout belongs to the payer' });
      if (order.status !== 'AWAITING_PAYMENT' || !['CREATED', 'PENDING'].includes(intent.status)) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Payment is not open' });
      if (order.paymentDeadline && this.clock.now() >= order.paymentDeadline) throw new ConflictException({ code: 'ORDER_EXPIRED', message: 'Payment deadline has passed' });
      return intent;
    });
    const intent = await authorize();
    if (!this.port.checkout) throw integrationUnavailable();
    const result = await this.port.checkout(intent.businessNo);
    await authorize();
    if (result.paymentIntentId !== intent.id) throw integrationUnavailable();
    return CheckoutViewSchema.parse(result);
  }
  async completeSimulated(actor: AuthenticatedUser, intentId: string, input: OrderCommandInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    assertPureCustomer(actor); this.store.assertEnabled('payment');
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Payment was not found' });
    const order = await readOrder(this.prisma, intent.orderId); assertOrderParticipant(order, actor.id);
    if ((intent.side === 'INITIATOR' ? order.initiatorId : order.recipientId) !== actor.id) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only the payer can complete a test payment' });
    const commandName = 'COMPLETE_SIMULATED_PAYMENT';
    const normalized = { ...input, intentId }; const hash = orderRequestHash(order.id, normalized);
    const where = { actorId_commandName_key: { actorId: actor.id, commandName, key } };
    await this.commands.execute({ actor, id: order.id, input: normalized, key, commandName, requestId, admissionIntentId: intentId }, async (tx, current) => {
      const own = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      if (own.orderId !== current.id || (own.side === 'INITIATOR' ? current.initiatorId : current.recipientId) !== actor.id) throw new ForbiddenException();
      if (current.status !== 'AWAITING_PAYMENT' || own.status !== 'PENDING') throw new ConflictException({ code: 'ORDER_PAYMENT_NOT_READY', message: 'Payment checkout is not ready' });
      return { auditAction: 'SIMULATED_PAYMENT_COMPLETION_ADMITTED', paymentIntentId: intentId };
    });
    const admission = await this.prisma.idempotencyRecord.findUniqueOrThrow({ where });
    if ((admission.response as Prisma.JsonObject).status !== 'IN_PROGRESS') return replayOrderCommand(admission, hash);
    let external = await this.adapter.queryPayment(intent.businessNo);
    if (external.status === 'PENDING') {
      const denied = await this.authorizeFreshCompletion(actor, order.id, intentId);
      if (denied) {
        // A logical admission permits recovery, not a new effect after hold/cancel/expiry.
        // The pending snapshot may meanwhile have become a saved, reconcilable success.
        external = await this.adapter.queryPayment(intent.businessNo);
        if (external.status !== 'SUCCESS') throw denied;
      }
    }
    if (external.status === 'PENDING') {
      // All retries and concurrent callers use exactly the same external fact identity.
      const candidate = { provider: 'simulated', eventId: `complete:${intent.id}`, kind: 'PAYMENT_SUCCEEDED', businessNo: intent.businessNo, occurredAt: admission.createdAt.toISOString(), externalTransactionId: `simulated-payment:${intent.id}`, amountFen: intent.amountFen, currency: 'CNY' };
      const raw = JSON.stringify(candidate);
      const event = this.adapter.verifySignedEvent(raw, createHmac('sha256', this.config.signingKey!).update(raw).digest('hex'));
      await this.store.recordEvent(event);
      external = await this.adapter.queryPayment(intent.businessNo);
    }
    if (external.status !== 'SUCCESS') throw new ConflictException({ code: 'ORDER_PAYMENT_NOT_READY', message: 'External payment is not complete' });
    await this.events.applyVerified(external.event);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id}::uuid FOR UPDATE`;
      const current = await readOrder(tx, order.id); assertOrderParticipant(current, actor.id);
      const saved = await tx.idempotencyRecord.findUniqueOrThrow({ where });
      if ((saved.response as Prisma.JsonObject).status !== 'IN_PROGRESS') return replayOrderCommand(saved, hash);
      const result = OrderCommandResultSchema.parse({ order: mapOrder(current), paymentIntentId: intentId });
      await tx.idempotencyRecord.update({ where, data: { response: result as unknown as Prisma.InputJsonObject } });
      return result;
    });
  }
  private authorizeFreshCompletion(actor: AuthenticatedUser, orderId: string, intentId: string): Promise<ConflictException | null> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intentId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, orderId);
      const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      const user = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, wechatOpenid: true, roles: { select: { role: true } }, adminCredential: { select: { userId: true } } } });
      if (!user || user.disabledAt !== null) throw new UnauthorizedException('Account is unavailable');
      assertPureCustomer({ id: user.id, roles: user.roles.map(({ role }) => role) });
      if (user.wechatOpenid === null || user.adminCredential !== null) throw new UnauthorizedException('Customer identity is unavailable');
      assertOrderParticipant(order, actor.id);
      if (intent.orderId !== order.id || (intent.side === 'INITIATOR' ? order.initiatorId : order.recipientId) !== actor.id) throw new ForbiddenException();
      if (order.status !== 'AWAITING_PAYMENT' || intent.status !== 'PENDING') return new ConflictException({ code: 'ORDER_PAYMENT_NOT_READY', message: 'Payment checkout is not ready' });
      if (!order.paymentDeadline || this.clock.now() >= order.paymentDeadline) return new ConflictException({ code: 'ORDER_EXPIRED', message: 'Payment deadline has passed' });
      return null;
    });
  }
}
