import { OrderCancellationSchema, OrderIssueSchema, type OrderAddressView, type OrderView } from '@barter/contracts';
import { Button, Image, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { OrderAction, OrderApi, PendingOrderCommand } from '../../../features/orders/order-api';
import { ApiClientError } from '../../../lib/api-client';
import { defaultIdentityProvider, defaultOrderApi } from '../../../lib/default-services';
import { AddressForm } from '../address-form';
import { PaymentActions } from '../payment-actions';
import { FulfillmentActions } from '../fulfillment-actions';
import { activeOrder, alertRole, buttonRole, buttonDisabled, fundsReady, inputLabel, money, orderStatusLabels, pureCustomer, sideLabel, type CustomerIdentity } from '../shared';

export function OrderDetailPage({ api = defaultOrderApi, orderId = Taro.getCurrentInstance().router?.params.id ?? '' }: { api?: OrderApi; orderId?: string }) {
  const [order, setOrder] = useState<OrderView | null>(null); const current = useRef<OrderView | null>(null);
  const [me, setMe] = useState<CustomerIdentity | null>(null); const [busy, setBusy] = useState(false);
  const identity = useRef<string | null>(null);
  const [error, setError] = useState(''); const [reason, setReason] = useState('');
  const [address, setAddress] = useState<OrderAddressView | null>(null); const [privateBusy, setPrivateBusy] = useState(false);
  const [unknown, setUnknown] = useState(false); const pending = useRef<PendingOrderCommand | null>(null);
  const generation = useRef(0); const lifecycle = useRef(0); const locked = useRef(false); const alive = useRef(false);
  const refreshRead = useRef(0);
  const apply = (incoming: OrderView) => {
    if (!alive.current || incoming.id !== orderId || (current.current && incoming.version < current.current.version)) return;
    current.current = incoming; setOrder(incoming);
  };
  const refresh = async () => {
    const read = ++refreshRead.current; ++generation.current; const life = lifecycle.current; setAddress(null); setPrivateBusy(false);
    try {
      const actor = await api.getMe(); const detail = await api.getOrder(orderId);
      if (alive.current && life === lifecycle.current && read === refreshRead.current) {
        if (identity.current !== null && identity.current !== actor.id) {
          generation.current += 1; pending.current = null; setUnknown(false); setReason(''); setError(''); setAddress(null); setPrivateBusy(false);
        }
        identity.current = actor.id; setMe(actor); apply(detail);
        pending.current = api.getPendingCommand(orderId, actor.id); setUnknown(!!pending.current);
      }
    } catch {
      if (alive.current && life === lifecycle.current && read === refreshRead.current) { setMe(null); setError('订单刷新失败，请核对登录身份后重试。'); }
    }
  };
  useEffect(() => {
    const unsubscribe = api.onIdentityInvalidated(() => {
      generation.current += 1; identity.current = null; pending.current = null;
      setMe(null); setAddress(null); setReason(''); setUnknown(false); setPrivateBusy(false);
      setError('登录身份已变化或无法核实，请刷新订单并重新确认操作。');
    });
    alive.current = true; const life = ++lifecycle.current; locked.current = false; setBusy(false); current.current = null; setOrder(null); setMe(null); setReason(''); setAddress(null); pending.current = null; setUnknown(false);
    void api.authenticate(defaultIdentityProvider).then(() => { if (alive.current && life === lifecycle.current) return refresh(); }).catch(() => { if (alive.current && life === lifecycle.current) setError('登录失败，请重新进入订单。'); });
    return () => { unsubscribe(); alive.current = false; generation.current += 1; lifecycle.current += 1; };
  }, [api, orderId]);
  const run = async (action: OrderAction, input: unknown, resourceId = orderId, retry = false) => {
    if (locked.current || !current.current || !pureCustomer(me) || !current.current.parties.some(p => p.userId === me?.id)) return;
    if (pending.current && !retry) return;
    locked.current = true; generation.current += 1; setBusy(true); setAddress(null); setError(''); setPrivateBusy(false);
    const life = lifecycle.current;
    const actor = me?.id;
    const command = retry ? pending.current! : { resourceId, action }; pending.current = command;
    try {
      const result = await (retry ? api.retryOriginal(orderId, actor!) : api.runLogicalCommand(command.resourceId, command.action, input, orderId));
      if (!alive.current || life !== lifecycle.current || identity.current !== actor) return;
      apply(result.order); pending.current = null; setUnknown(false); setReason('');
      await refresh(); // Historical successful replay may be older than the current order.
    } catch (cause) {
      if (!alive.current || life !== lifecycle.current || identity.current !== actor) return;
      if (cause instanceof ApiClientError && cause.statusCode < 500) {
        pending.current = null; setUnknown(false);
        if (cause.statusCode === 403 || cause.statusCode === 409) {
          setMe(null); await refresh(); setError('订单已更新，请核对后重新确认操作');
        } else setError('操作未获批准，请刷新订单后核对。');
      } else {
        setUnknown(true); setError('操作结果未明，请重试原操作并刷新核对。');
      }
    } finally { if (life === lifecycle.current) { locked.current = false; if (alive.current) setBusy(false); } }
  };
  const privateReadError = (cause: unknown) => {
    if (identity.current !== me?.id) return;
    if (cause instanceof ApiClientError && (cause.statusCode === 403 || cause.statusCode === 409)) {
      setAddress(null); setMe(null); void refresh(); setError('订单已更新，请核对后重新确认操作');
    }
  };
  const readAddress = async (side: 'self' | 'outgoing') => {
    if (privateBusy || busy) return;
    const read = generation.current; const version = current.current?.version; const actor = identity.current; const life = lifecycle.current;
    const isCurrent = () => alive.current && life === lifecycle.current && generation.current === read && identity.current === actor && current.current?.version === version;
    setAddress(null); setPrivateBusy(true);
    try {
      const result = await api.getShippingAddress(orderId, side);
      if (isCurrent()) setAddress(result);
    } catch (cause) { if (isCurrent()) { setError('资料读取失败，请刷新订单核对。'); privateReadError(cause); } }
    finally { if (isCurrent()) setPrivateBusy(false); }
  };
  const own = order?.parties.find(p => p.userId === me?.id);
  const customer = pureCustomer(me) && !!own;
  const cancellation = order?.cancellation?.status === 'REQUESTED' ? order.cancellation : null;
  const active = !!order && activeOrder(order); const actions = customer && active && !unknown;
  const cancelInput = order && OrderCancellationSchema.safeParse({ expectedVersion: order.version, reason });
  const issueInput = order && OrderIssueSchema.safeParse({ expectedVersion: order.version, reason });
  const safeCancel = order && ['AWAITING_DETAILS', 'AWAITING_PAYMENT', 'AWAITING_FULFILLMENT'].includes(order.status) && order.parties.every(p => !p.outgoingShipment && !p.incomingDeliveredAt && (order.terms.deliveryMode === 'COURIER' || p.handedOverAt === null));
  return <View style={{ padding: '16px', overflowWrap: 'anywhere' }}>
    <Text>交换订单</Text>
    <Button {...buttonRole} disabled={busy} onClick={() => { if (!locked.current) void refresh(); }}>刷新订单</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {unknown && customer && <Button {...buttonRole} disabled={busy} onClick={() => { if (pending.current) void run(pending.current.action, undefined, pending.current.resourceId, true); }}>重试原操作</Button>}
    {!order ? <Text>加载订单中</Text> : <View>
      <Text>{orderStatusLabels[order.status]}</Text><Text>订单版本：{order.version}</Text><Text>订单号：{order.id}</Text>
      {order.simulation && <Text>测试支付／测试物流，不产生真实资金或寄递</Text>}
      {order.holdReason && <Text>待处理原因：{order.holdReason}；物品仍被占用</Text>}
      {order.status === 'CANCEL_PENDING' && <Text>资金核对中，核对退款与未决付款完成前物品仍被占用</Text>}
      {order.status === 'SETTLING' && <Text>差价结算与保证金返还由后台核对，尚未完成</Text>}
      <Text>规则：{order.rules.version} · 每人保证金 {money(order.rules.depositFen)} · 平台服务费 {money(order.rules.feeFen)}</Text>
      <Text>差价：{money(order.terms.differenceFen)} · {order.terms.payer === 'NONE' ? '无需补差' : sideLabel(order.terms.payer) + '补差'}</Text>
      <Text>{order.terms.deliveryMode === 'COURIER' ? '快递' : '面交'} · 发起方运费估计 {money(order.terms.initiatorShippingFen)} · 接收方运费估计 {money(order.terms.recipientShippingFen)}</Text>
      {order.items.map(item => <View key={item.itemId}>
        <Text>{sideLabel(item.side)}：{item.title}</Text><Text>{item.description}</Text><Text>参考价值：{money(item.referenceValueFen)} · 成色：{item.condition} · 想换：{item.wantedText}</Text>
        {item.imageUrls.map(url => <Image key={url} src={url} mode='aspectFit' style={{ width: '120px', height: '90px' }} />)}
      </View>)}
      {order.parties.map(p => <View key={p.side}>
        <Text>{sideLabel(p.side)}{p.userId === me?.id ? '（我）' : ''}进度</Text>
        <Text>资料：{p.addressReady ? '已准备' : order.terms.deliveryMode === 'IN_PERSON' ? '面交无需地址' : '待准备'}</Text>
        {order.terms.deliveryMode === 'IN_PERSON' && <Text>{sideLabel(p.side)}面交交出：{p.handedOverAt === undefined ? '进度待刷新核对' : p.handedOverAt ?? '尚未交出'}</Text>}
        {p.payments.map(payment => <Text key={payment.id}>{sideLabel(p.side)}{payment.purpose === 'DEPOSIT' ? '保证金' : '差价'}：{money(payment.amountFen)} · {payment.status}</Text>)}
        <Text>去件：{p.outgoingShipment ? p.outgoingShipment.status + ' · ' + p.outgoingShipment.carrier + ' · ' + p.outgoingShipment.trackingNumber : '未登记运单'}</Text>
        <Text>来件：{p.incomingDeliveredAt ? '已到达 ' + p.incomingDeliveredAt : '尚未确认到达'}</Text>
        <Text>验收：{p.acceptedAt ?? '待验收'}</Text>{p.acceptanceDeadline && <Text>{sideLabel(p.side)}验收截止：{p.acceptanceDeadline}</Text>}
      </View>)}
      {order.detailsDeadline && <Text>资料截止：{order.detailsDeadline}</Text>}
      {order.paymentDeadline && <Text>付款截止：{order.paymentDeadline}</Text>}
      {order.fulfillmentDeadline && <Text>共同履约截止：{order.fulfillmentDeadline}</Text>}
      <Text>创建时间：{order.createdAt} · 更新时间：{order.updatedAt}</Text>
      {order.cancellation && <Text>取消请求：{sideLabel(order.cancellation.requestedBySide)} · {order.cancellation.status} · {order.cancellation.reason}</Text>}
      {actions && order.status === 'AWAITING_DETAILS' && <AddressForm key={`${order.id}:${me?.id}:${order.version}`} version={order.version} busy={busy} onSave={input => run('address', input)} />}
      {customer && own?.addressReady && <Button {...buttonRole} disabled={busy || privateBusy} onClick={() => { void readAddress('self'); }}>查看我的收货资料</Button>}
      {actions && !cancellation && order.terms.deliveryMode === 'COURIER' && ['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) && fundsReady(order) && <Button {...buttonRole} disabled={busy || privateBusy} onClick={() => { void readAddress('outgoing'); }}>查看我的去件收货资料</Button>}
      {address && <View><Text>即时收货资料：{address.recipientName} · {address.phone} · {address.region} · {address.detail}</Text><Button {...buttonRole} onClick={() => setAddress(null)}>隐藏收货资料</Button></View>}
      {actions && own && order.status === 'AWAITING_PAYMENT' && <PaymentActions key={`${order.id}:${me?.id}:${order.version}`} order={order} own={own} busy={busy} api={api} onCommand={run} onReadError={privateReadError} />}
      {actions && own && !cancellation && ['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) && <FulfillmentActions key={`${order.id}:${me?.id}:${order.version}`} order={order} own={own} busy={busy} onCommand={run} />}
      {actions && !cancellation && (safeCancel || !!own?.incomingDeliveredAt && !own.acceptedAt) && <View>
        <Text>操作原因</Text><Input {...inputLabel('操作原因')} value={reason} disabled={busy} onInput={e => setReason(e.detail.value)} />
        {safeCancel && <Button {...buttonRole} {...buttonDisabled(busy || !cancelInput?.success)} disabled={busy || !cancelInput?.success} onClick={() => { if (!busy && cancelInput?.success) void run('cancellation', cancelInput.data); }}>申请取消订单</Button>}
        {own?.incomingDeliveredAt && !own.acceptedAt && <Button {...buttonRole} {...buttonDisabled(busy || !issueInput?.success)} disabled={busy || !issueInput?.success} onClick={() => { if (!busy && issueInput?.success) void run('issue', issueInput.data); }}>报告我的来件异议</Button>}
      </View>}
      {actions && own && cancellation && <View>
        <Text>取消待回应，禁止交接与结算；原截止时间继续运行</Text>
        {cancellation.requestedBySide === own.side ? <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void run('withdrawCancellation', { expectedVersion: order.version, cancellationId: cancellation.id }); }}>撤回取消请求</Button> : <View>
          <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void run('respondCancellation', { expectedVersion: order.version, cancellationId: cancellation.id, decision: 'AGREE' }); }}>同意取消订单</Button>
          <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void run('respondCancellation', { expectedVersion: order.version, cancellationId: cancellation.id, decision: 'REJECT' }); }}>拒绝取消订单</Button>
        </View>}
      </View>}
    </View>}
  </View>;
}
export default OrderDetailPage;
