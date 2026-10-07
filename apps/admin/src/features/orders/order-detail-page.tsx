import type { OrderView } from '@barter/contracts';
import { Alert, Button, Card, Image, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, type OrderReadApi } from '../../lib/api-client';
import { formatFen, formatUtc } from '../review/review-queue-page';
import { orderStatusLabels, sideLabel } from './order-list-page';

const time = (value: string | null | undefined) => value ? formatUtc(value) : '暂无记录';
const shipmentLabels = { REGISTERED: '已登记（尚未确认揽收）', COLLECTED: '已确认揽收', DELIVERED: '已确认签收', EXCEPTION: '物流异常' };

export function OrderDetailPage({ client = apiClient, orderId }: { client?: OrderReadApi; orderId?: string }) {
  const params = useParams(); const id = orderId ?? params.orderId ?? '';
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setOrder(null); setError('');
    void client.getOrder(id).then(value => { if (active) setOrder(value); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '加载失败'); });
    return () => { active = false; };
  }, [client, id, retry]);
  return <main className="workspace-page order-page">
    <Link to="/orders">返回订单列表</Link>
    <Typography.Title level={1}>订单详情</Typography.Title>
    <p>仅供查询，运营不能代替用户履约或处理资金</p>
    {error ? <div><Alert type="error" message={error} /><Button aria-label="重试" onClick={() => setRetry(value => value + 1)}>重试</Button></div> : !order ? <p role="status">加载订单中</p> : <>
      <Card title={order.id}>
        <p>{orderStatusLabels[order.status]} · 修订 {order.version}</p>
        {order.simulation && <p>测试支付／测试物流，不产生真实资金或寄递</p>}
        {order.holdReason && <Alert type="warning" message={order.holdReason} />}
        {(order.status === 'CANCEL_PENDING' || order.status === 'SETTLING') && <p>资金核对中，以可信结果为准</p>}
        <p>来源提案：<Link to={`/proposals/${order.proposalId}`}>{order.proposalId}</Link></p>
        <p>差价：{formatFen(order.terms.differenceFen)} · {order.terms.payer === 'NONE' ? '无需补差' : `${sideLabel(order.terms.payer)}补差`}</p>
        <p>{order.terms.deliveryMode === 'IN_PERSON' ? '面交' : '快递'} · 双方保证金各 {formatFen(order.rules.depositFen)} · 服务费 {formatFen(order.rules.feeFen)}</p>
        <p>规则：{order.rules.version}</p>
        <p>发起方运费估计：{formatFen(order.terms.initiatorShippingFen)} · 接收方运费估计：{formatFen(order.terms.recipientShippingFen)}</p>
        <p>资料截止：{time(order.detailsDeadline)}</p><p>付款截止：{time(order.paymentDeadline)}</p><p>共同履约截止：{time(order.fulfillmentDeadline)}</p>
        <p>期限仅展示，查询不会推进订单状态</p>
        <p>创建：{time(order.createdAt)} · 更新：{time(order.updatedAt)}</p>
      </Card>
      <div className="order-sides">{order.parties.map(party => <Card key={party.side} title={`${sideLabel(party.side)}进度`}>
        <p>用户：{party.userId}</p><p>收货资料：{party.addressReady ? '已备齐' : '未备齐'}</p>
        {party.payments.length === 0 ? <p>暂无付款记录</p> : party.payments.map(payment => <section key={payment.id}><h3>{payment.purpose === 'DEPOSIT' ? '保证金' : '差价'}</h3><p>{payment.status} · {formatFen(payment.amountFen)}</p><p>付款义务：{payment.id}</p>{payment.status === 'UNKNOWN' && <p>付款结果待核对</p>}</section>)}
        {party.outgoingShipment ? <section><h3>去件物流</h3><p>{shipmentLabels[party.outgoingShipment.status]}</p><p>{party.outgoingShipment.carrier} · {party.outgoingShipment.trackingNumber}</p><p>登记：{time(party.outgoingShipment.registeredAt)}</p><p>揽收：{time(party.outgoingShipment.collectedAt)}</p><p>签收：{time(party.outgoingShipment.deliveredAt)}</p></section> : <p>暂无去件运单</p>}
        <p>面交交出：{party.handedOverAt === undefined ? '未知，需刷新查询' : time(party.handedOverAt)}</p>
        <p>来件收到：{time(party.incomingDeliveredAt)}</p><p>验收截止：{time(party.acceptanceDeadline)}</p><p>已验收：{time(party.acceptedAt)}</p>
      </Card>)}</div>
      <Card title="交换物品快照"><div className="order-sides">{order.items.map(item => <section key={item.itemId}><h3>{item.title}</h3><p>{sideLabel(item.side)} · 原物品 {item.itemId} · v{item.itemVersion}</p><p>{item.description}</p><p>{item.condition} · {formatFen(item.referenceValueFen)}</p><p>想换：{item.wantedText}</p><div className="item-image-grid">{item.imageUrls.map((url, index) => <Image key={url} src={url} alt={`${item.title} 图片 ${index + 1}`} />)}</div></section>)}</div></Card>
      <Card title="最近取消协商">{order.cancellation ? <><p>{sideLabel(order.cancellation.requestedBySide)} · {order.cancellation.status}</p><p>{order.cancellation.reason}</p><p>请求：{time(order.cancellation.requestedAt)} · 回应：{time(order.cancellation.respondedAt)}</p></> : <p>暂无取消请求</p>}</Card>
    </>}
  </main>;
}
