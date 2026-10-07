import { OrderStatusSchema, type OrderStatus, type OrderView } from '@barter/contracts';
import { Alert, Button, Card, Empty, Table, Typography } from 'antd';
import { useEffect, useState, type HTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, type OrderReadApi, type OrderReadQuery } from '../../lib/api-client';
import { formatFen, formatUtc } from '../review/review-queue-page';

export const orderStatusLabels: Record<OrderStatus, string> = {
  AWAITING_DETAILS: '待双方资料', AWAITING_PAYMENT: '待付款', AWAITING_FULFILLMENT: '待双方履约', IN_TRANSIT: '运输中',
  AWAITING_ACCEPTANCE: '待双方验收', SETTLING: '结算核对中', COMPLETED: '已完成', CANCEL_PENDING: '取消资金核对中', CANCELLED: '已取消', ON_HOLD: '待处理',
};
export const sideLabel = (side: string) => side === 'INITIATOR' ? '发起方' : '接收方';
const detailLink = (order: OrderView) => <Link to={`/orders/${order.id}`}>查看订单 {order.id}</Link>;
function NamedTable(props: HTMLAttributes<HTMLTableElement>) { return <table {...props} aria-label="订单查询" />; }

function Progress({ order }: { order: OrderView }) {
  return <>{order.parties.map(party => <p key={party.side}>
    {sideLabel(party.side)}：{party.addressReady ? '资料已备齐' : '资料未备齐'} · {party.payments.length ? party.payments.map(payment => `${payment.purpose === 'DEPOSIT' ? '保证金' : '差价'} ${payment.status} ${formatFen(payment.amountFen)}`).join(' / ') : '暂无付款记录'} · {party.acceptedAt ? '已验收' : party.handedOverAt ? '已面交交出' : party.outgoingShipment ? `去件 ${party.outgoingShipment.status}` : '未登记交出'}
  </p>)}</>;
}

export function OrderListPage({ client = apiClient }: { client?: OrderReadApi }) {
  const [query, setQuery] = useState<OrderReadQuery>({});
  const [retry, setRetry] = useState(0);
  const [items, setItems] = useState<OrderView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    if (!query.cursor) { setItems(null); setNextCursor(null); }
    void client.listOrders(query).then(page => {
      if (!active) return;
      setItems(previous => query.cursor ? [...(previous ?? []), ...page.items.filter(order => !previous?.some(old => old.id === order.id))] : page.items);
      setNextCursor(page.nextCursor); setBusy(false);
    }).catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : '加载失败'); setBusy(false); } });
    return () => { active = false; };
  }, [client, query, retry]);

  return <main className="workspace-page order-page">
    <Typography.Title level={1}>订单查询</Typography.Title>
    <p>仅供查询，运营不能代替用户履约或处理资金</p>
    <label className="order-filter">订单状态<select aria-label="订单状态" value={query.status ?? ''} onChange={event => { setQuery(event.target.value ? { status: event.target.value as OrderStatus } : {}); }}>
      <option value="">全部状态</option>{OrderStatusSchema.options.map(status => <option key={status} value={status}>{orderStatusLabels[status]}{status === 'ON_HOLD' ? '（异常）' : ''}</option>)}
    </select></label>
    {error && <div><Alert type="error" message={error} /><Button aria-label="重试" onClick={() => setRetry(value => value + 1)}>重试</Button></div>}
    {busy && <p role="status">加载订单中</p>}
    {items?.length === 0 ? <Empty description="暂无订单" /> : items && (mobile ? <ul className="mobile-review-list" aria-label="订单查询">
      {items.map(order => <li key={order.id}><Card>{detailLink(order)}<p>{orderStatusLabels[order.status]} · v{order.version}</p><Progress order={order} />{order.holdReason && <p>{order.holdReason}</p>}<time>{formatUtc(order.createdAt)}</time></Card></li>)}
    </ul> : <Table rowKey="id" dataSource={items} pagination={false} components={{ table: NamedTable }} columns={[
      { title: '订单', render: (_, order) => detailLink(order) },
      { title: '状态', render: (_, order) => <>{orderStatusLabels[order.status]}<p>{order.holdReason}</p></> },
      { title: '双方进度与资金', render: (_, order) => <Progress order={order} /> },
      { title: '创建时间', render: (_, order) => formatUtc(order.createdAt) },
    ]} />)}
    {nextCursor && !error && <Button disabled={busy} onClick={() => setQuery({ ...(query.status ? { status: query.status } : {}), cursor: nextCursor })}>加载更多</Button>}
  </main>;
}
