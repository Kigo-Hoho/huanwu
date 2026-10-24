import { Text, View } from '@tarojs/components';
import { useEffect, useState } from 'react';
import type { TradingRestrictionView } from '@barter/contracts';
import type { AfterSalesApi } from '../../features/after-sales/after-sales-api';
import { alertRole } from '../orders/shared';

export function TradingFreezeBanner({ api }: { api: Pick<AfterSalesApi, 'getTradingRestriction'> }) {
  const [restriction, setRestriction] = useState<TradingRestrictionView | null>(null);
  useEffect(() => {
    let alive = true;
    void api.getTradingRestriction().then(value => { if (alive) setRestriction(value); }).catch(() => { if (alive) setRestriction(null); });
    return () => { alive = false; };
  }, [api]);
  if (!restriction || restriction.status !== 'FROZEN') return null;
  return <View>
    <Text {...alertRole}>交易已冻结{restriction.reason ? `：${restriction.reason}` : ''}</Text>
    <Text>仍可处理售后与退货；新建交易与提案暂不可用。</Text>
  </View>;
}
