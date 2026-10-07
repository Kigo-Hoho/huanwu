import type { OrderStatus, OrderView, Role } from '@barter/contracts';
export { alertRole, buttonRole, buttonDisabled, inputLabel, money } from '../proposals/shared';
export const orderStatusLabels: Record<OrderStatus, string> = {
  AWAITING_DETAILS: '待双方资料', AWAITING_PAYMENT: '待双方付款', AWAITING_FULFILLMENT: '待双方履约',
  IN_TRANSIT: '运输中', AWAITING_ACCEPTANCE: '待双方验收', SETTLING: '结算核对中', COMPLETED: '已完成',
  CANCEL_PENDING: '取消资金核对中', CANCELLED: '已取消', ON_HOLD: '异常待处理',
};
export type CustomerIdentity = { id: string; roles: Role[] };
export const pureCustomer = (me: CustomerIdentity | null) => me?.roles.length === 1 && me.roles[0] === 'CUSTOMER';
export const sideLabel = (side: string) => side === 'INITIATOR' ? '发起方' : '接收方';
export const activeOrder = (order: OrderView) => ['AWAITING_DETAILS', 'AWAITING_PAYMENT', 'AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status);
export const fundsReady = (order: OrderView) => order.parties.every(p =>
  p.payments.some(payment => payment.purpose === 'DEPOSIT' && payment.status === 'PAID') &&
  (order.terms.payer !== p.side || p.payments.some(payment => payment.purpose === 'DIFFERENCE' && payment.status === 'PAID')));
