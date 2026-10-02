import type { PublicItemView } from '@barter/contracts';
import { Button, Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState, type ComponentProps } from 'react';

import { defaultApiClient } from '../../../lib/default-services';

const alertRole = { role: 'alert' } as unknown as ComponentProps<typeof Text>;
interface PublicDetailApi { getPublicItem(itemId: string): Promise<PublicItemView> }

export function PublicItemDetailPage({
  api = defaultApiClient,
  itemId = Taro.getCurrentInstance().router?.params.id ?? '',
}: { api?: PublicDetailApi; itemId?: string }) {
  const [item, setItem] = useState<PublicItemView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!itemId) { setError('缺少物品编号。'); return; }
    void api.getPublicItem(itemId).then((value) => { if (active) setItem(value); }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : '加载物品失败。');
    });
    return () => { active = false; };
  }, [api, itemId]);

  if (error) return <View><Text {...alertRole}>{error}</Text></View>;
  if (!item) return <View><Text>加载中</Text></View>;
  return <View>
    <Text>{item.title}</Text>
    <Text>{item.description}</Text>
    <Text>￥{(item.referenceValueFen / 100).toFixed(2)}</Text>
    <Text>成色：{item.condition}</Text>
    <Text>想换：{item.wantedText}</Text>
    <Text>{item.availableForProposal ? '可投物' : '暂不可投'}</Text>
    <Button {...({ role: 'button', 'aria-disabled': !item.availableForProposal } as unknown as ComponentProps<typeof Button>)} disabled={!item.availableForProposal} onClick={() => { void Taro.navigateTo({ url: `/pages/proposals/create/index?targetId=${encodeURIComponent(item.id)}` }); }}>我要换</Button>
    {item.imageUrls.map((url, index) => <Image key={url} {...({ alt: `${item.title} 图片 ${index + 1}` } as unknown as ComponentProps<typeof Image>)} src={url} mode='aspectFill' />)}
  </View>;
}

export default PublicItemDetailPage;
