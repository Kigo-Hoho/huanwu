import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import type { OrderView } from '@barter/contracts';
import { useEffect, useRef, useState } from 'react';
import type { OrderApi } from '../../../features/orders/order-api';
import { defaultIdentityProvider, defaultOrderApi } from '../../../lib/default-services';
import { alertRole, buttonRole, orderStatusLabels, pureCustomer } from '../shared';

export function OrderListPage({ api = defaultOrderApi, navigate = (url: string) => { void Taro.navigateTo({ url }); } }: {
  api?: Pick<OrderApi, 'authenticate' | 'getMe' | 'listMyOrders'>; navigate?: (url: string) => void;
}) {
  const [orders, setOrders] = useState<OrderView[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const generation = useRef(0); const locked = useRef(false);
  useEffect(() => {
    let active = true; const current = ++generation.current; locked.current = true; setBusy(true);
    void (async () => {
      await api.authenticate(defaultIdentityProvider); const me = await api.getMe();
      if (!pureCustomer(me)) throw new Error('请使用普通用户身份查看我的订单。');
      const result = await api.listMyOrders();
      if (active && current === generation.current) { setOrders(result.items); setCursor(result.nextCursor); setError(''); }
    })().catch(() => { if (active && current === generation.current) { setOrders([]); setCursor(null); setError('订单加载失败，请核对登录身份后刷新。'); } }).finally(() => { if (active && current === generation.current) { locked.current = false; setBusy(false); } });
    return () => { active = false; };
  }, [api, refresh]);
  const more = async () => {
    if (!cursor || locked.current) return;
    locked.current = true; setBusy(true); const current = generation.current;
    try {
      const result = await api.listMyOrders({ cursor });
      if (current === generation.current) { setOrders(old => [...old, ...result.items.filter(item => !old.some(o => o.id === item.id))]); setCursor(result.nextCursor); }
    } catch { setError('更多订单加载失败，请重试。'); }
    finally { locked.current = false; setBusy(false); }
  };
  return <View style={{ overflowWrap: 'anywhere', padding: '16px' }}>
    <Text>我的订单</Text><Button {...buttonRole} disabled={busy} onClick={() => { if (!locked.current) setRefresh(value => value + 1); }}>刷新订单列表</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {!busy && !error && !orders.length && <Text>暂无订单</Text>}
    {orders.map(order => <View key={order.id}><Text>{orderStatusLabels[order.status]}</Text><Text>{order.id}</Text>
      {order.simulation && <Text>测试支付／测试物流，不产生真实资金或寄递</Text>}
      <Button {...buttonRole} onClick={() => navigate(`/pages/orders/detail/index?id=${encodeURIComponent(order.id)}`)}>查看订单 {order.id}</Button>
    </View>)}
    {cursor && <Button {...buttonRole} disabled={busy} onClick={() => { void more(); }}>加载更多订单</Button>}
  </View>;
}
export default OrderListPage;
