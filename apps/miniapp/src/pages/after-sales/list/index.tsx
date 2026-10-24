import type { CaseView } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { AfterSalesApi } from '../../../features/after-sales/after-sales-api';
import { defaultAfterSalesApi, defaultIdentityProvider } from '../../../lib/default-services';
import { alertRole, buttonRole, pureCustomer, type CustomerIdentity } from '../../orders/shared';
import { TradingFreezeBanner } from '../trading-freeze-banner';

const statusLabels: Record<string, string> = {
  OPEN: '已开立', AWAITING_RESPONSE: '待回应', UNDER_REVIEW: '审核中', AWAITING_AGREEMENT: '待双方同意',
  EXECUTING: '执行中', RESOLVED: '已结案', REJECTED: '已驳回', WITHDRAWN: '已撤回',
};

export function AfterSalesListPage({
  api = defaultAfterSalesApi,
  navigate = (url: string) => { void Taro.navigateTo({ url }); },
}: {
  api?: AfterSalesApi;
  navigate?: (url: string) => void;
}) {
  const [items, setItems] = useState<CaseView[]>([]);
  const [me, setMe] = useState<CustomerIdentity | null>(null);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const alive = useRef(false);
  const refresh = async () => {
    try {
      const actor = await api.getMe();
      const page = await api.list();
      if (!alive.current) return;
      setMe(actor); setItems(page.items); setCursor(page.nextCursor); setError('');
    } catch { if (alive.current) setError('售后列表刷新失败，请核对登录身份后重试。'); }
  };
  useEffect(() => {
    const unsub = api.onIdentityInvalidated(() => { setMe(null); setItems([]); setError('登录身份已变化或无法核实，请刷新后重新确认操作。'); });
    alive.current = true;
    void api.authenticate(defaultIdentityProvider).then(() => { if (alive.current) return refresh(); }).catch(() => { if (alive.current) setError('登录失败。'); });
    return () => { unsub(); alive.current = false; };
  }, [api]);
  return <View style={{ padding: '16px', overflowWrap: 'anywhere' }}>
    <Text>我的售后</Text>
    <TradingFreezeBanner api={api} />
    <Button {...buttonRole} onClick={() => { void refresh(); }}>刷新</Button>
    {error && <Text {...alertRole}>{error}</Text>}
    {!pureCustomer(me) && me && <Text>当前身份无法操作客户售后</Text>}
    {items.map(item => <View key={item.id}>
      <Text>{statusLabels[item.status] ?? item.status} · 版本 {item.version}</Text>
      <Text>{item.reason}</Text>
      <Button {...buttonRole} onClick={() => navigate(`/pages/after-sales/detail/index?id=${item.id}`)}>查看工单</Button>
    </View>)}
    {cursor && <Button {...buttonRole} onClick={() => {
      void api.list({ cursor }).then(page => { if (alive.current) { setItems(prev => [...prev, ...page.items]); setCursor(page.nextCursor); } });
    }}>加载更多</Button>}
  </View>;
}
export default AfterSalesListPage;
