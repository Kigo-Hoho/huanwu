import type { OrderPartyView, OrderView, PaymentPurpose } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import { useEffect, useRef, useState } from 'react';
import { simulationDriversEnabled, type OrderAction, type OrderApi } from '../../features/orders/order-api';
import { alertRole, buttonRole, money } from './shared';

export function PaymentActions({ order, own, busy, api, onCommand, onReadError }: {
  order: OrderView; own: OrderPartyView; busy: boolean; api: Pick<OrderApi, 'getCheckout'>;
  onCommand: (action: OrderAction, input: unknown, resourceId?: string) => Promise<void>;
  onReadError: (cause: unknown) => void;
}) {
  const [message, setMessage] = useState(''); const [querying, setQuerying] = useState(false);
  const read = useRef(0);
  useEffect(() => () => { read.current += 1; }, []);
  const purposes: PaymentPurpose[] = order.terms.payer === own.side ? ['DEPOSIT', 'DIFFERENCE'] : ['DEPOSIT'];
  const enabled = order.simulation && simulationDriversEnabled();
  const checkout = async (intentId: string) => {
    if (busy || querying) return;
    const generation = ++read.current; setQuerying(true); setMessage('');
    try {
      const result = await api.getCheckout(order.id, intentId);
      if (generation !== read.current) return;
      setMessage(result.status === 'PENDING' ? '付款参数准备中，资金状态以订单刷新为准' :
        enabled && result.provider === 'simulated' ? '测试付款参数已准备，使用自己的测试付款操作后刷新核对' : '真实付款能力尚未接入，当前不可用');
      // Provider params are deliberately never displayed, persisted or treated as payment success.
    } catch (cause) { if (generation === read.current) { setMessage('付款参数读取失败，请刷新核对'); onReadError(cause); } }
    finally { if (generation === read.current) setQuerying(false); }
  };
  return <View>
    {!order.simulation && <Text>真实付款能力尚未接入，当前不可用</Text>}
    {message && <Text {...alertRole}>{message}</Text>}
    {purposes.map(purpose => {
      const label = purpose === 'DEPOSIT' ? '保证金' : '差价'; const payment = own.payments.find(p => p.purpose === purpose);
      return <View key={purpose}>
        <Text>我的{label}：{money(payment?.amountFen ?? (purpose === 'DEPOSIT' ? order.rules.depositFen : order.terms.differenceFen))} · {payment?.status ?? '未发起'}</Text>
        {!payment && <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void onCommand('payment', { expectedVersion: order.version, purpose }); }}>发起{label}付款</Button>}
        {payment && ['CREATED', 'PENDING', 'UNKNOWN'].includes(payment.status) && <Button {...buttonRole} disabled={busy || querying} onClick={() => { void checkout(payment.id); }}>查询{label}付款参数</Button>}
        {enabled && payment?.status === 'PENDING' && <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void onCommand('testPayment', { expectedVersion: order.version }, payment.id); }}>完成测试{label}付款</Button>}
      </View>;
    })}
  </View>;
}
