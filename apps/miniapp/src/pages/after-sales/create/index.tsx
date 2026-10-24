import { Button, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { AfterSalesApi } from '../../../features/after-sales/after-sales-api';
import { ApiClientError } from '../../../lib/api-client';
import { defaultAfterSalesApi, defaultIdentityProvider } from '../../../lib/default-services';
import { alertRole, buttonDisabled, buttonRole, inputLabel, pureCustomer, type CustomerIdentity } from '../../orders/shared';

export function AfterSalesCreatePage({
  api = defaultAfterSalesApi,
  orderId = Taro.getCurrentInstance().router?.params.orderId ?? '',
  orderVersion: orderVersionProp,
  navigate = (url: string) => { void Taro.navigateTo({ url }); },
}: {
  api?: AfterSalesApi;
  orderId?: string;
  orderVersion?: number;
  navigate?: (url: string) => void;
}) {
  const initialVersion = orderVersionProp ?? Number(Taro.getCurrentInstance().router?.params.orderVersion ?? '0');
  const [me, setMe] = useState<CustomerIdentity | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [orderVersion, setOrderVersion] = useState(initialVersion > 0 ? initialVersion : 0);
  const alive = useRef(false);
  const identity = useRef<string | null>(null);
  useEffect(() => {
    const unsub = api.onIdentityInvalidated(() => {
      identity.current = null; setMe(null); setError('登录身份已变化或无法核实，请刷新后重新确认操作。');
    });
    alive.current = true;
    void api.authenticate(defaultIdentityProvider).then(async () => {
      if (!alive.current) return;
      try {
        const actor = await api.getMe();
        if (!alive.current) return;
        identity.current = actor.id; setMe(actor);
      } catch { if (alive.current) setError('登录失败，请重新进入。'); }
    }).catch(() => { if (alive.current) setError('登录失败，请重新进入。'); });
    return () => { unsub(); alive.current = false; };
  }, [api]);
  const parsedOk = reason.trim().length > 0 && orderVersion > 0 && pureCustomer(me);
  return <View style={{ padding: '16px', overflowWrap: 'anywhere' }}>
    <Text>申请售后</Text>
    <Text>订单号：{orderId}</Text>
    {orderVersion > 0 && <Text>订单版本：{orderVersion}</Text>}
    {error && <Text {...alertRole}>{error}</Text>}
    <Input {...inputLabel('售后原因')} value={reason} disabled={busy} onInput={e => setReason(e.detail.value)} />
    <Button {...buttonRole} {...buttonDisabled(busy || !parsedOk)} disabled={busy || !parsedOk} onClick={() => {
      if (busy || !parsedOk || !me) return;
      setBusy(true); setError('');
      const actor = me.id;
      void api.open(orderId, { expectedOrderVersion: orderVersion, reason: reason.trim() }).then(result => {
        if (!alive.current || identity.current !== actor) return;
        setOrderVersion(result.orderVersion);
        navigate(`/pages/after-sales/detail/index?id=${result.case.id}&orderVersion=${result.orderVersion}`);
      }).catch(cause => {
        if (!alive.current || identity.current !== actor) return;
        if (cause instanceof ApiClientError && (cause.statusCode === 403 || cause.statusCode === 409)) {
          setError('订单已更新，请核对后重新确认操作');
        } else if (cause instanceof ApiClientError && cause.statusCode < 500) {
          setError('操作未获批准，请刷新订单后核对。');
        } else setError('操作结果未明，请重试原操作并刷新核对。');
      }).finally(() => { if (alive.current) setBusy(false); });
    }}>提交售后申请</Button>
  </View>;
}
export default AfterSalesCreatePage;
