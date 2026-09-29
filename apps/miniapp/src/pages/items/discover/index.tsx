import type { PublicItemList, PublicItemView } from '@barter/contracts';
import { Button, Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState, type ComponentProps } from 'react';

import { defaultApiClient } from '../../../lib/default-services';

const buttonRole = { role: 'button' } as unknown as ComponentProps<typeof Button>;
const alertRole = { role: 'alert' } as unknown as ComponentProps<typeof Text>;

interface DiscoverApi { listPublicItems(cursor?: string): Promise<PublicItemList> }

export function DiscoverItemsPage({
  api = defaultApiClient,
  navigateToDetail = (url: string) => { void Taro.navigateTo({ url }); },
}: {
  api?: DiscoverApi;
  navigateToDetail?: (url: string) => void;
}) {
  const [items, setItems] = useState<PublicItemView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load(cursor?: string) {
    setLoading(true);
    setError('');
    try {
      const page = await api.listPublicItems(cursor);
      setItems((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载物品失败。');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [api]);

  return <View>
    <Text>找换</Text>
    {error ? <Text {...alertRole}>{error}</Text> : null}
    {items.map((item) => <View key={item.id}>
      {item.imageUrls[0] ? <Image src={item.imageUrls[0]} mode='aspectFill' /> : null}
      <Text>{item.title}</Text>
      <Text>￥{(item.referenceValueFen / 100).toFixed(2)}</Text>
      <Text>{item.availableForProposal ? '可投物' : '暂不可投'}</Text>
      <Button {...buttonRole} onClick={() => navigateToDetail(`/pages/items/public-detail/index?id=${encodeURIComponent(item.id)}`)}>查看 {item.title}</Button>
    </View>)}
    {nextCursor ? <Button {...buttonRole} disabled={loading} onClick={() => void load(nextCursor)}>加载更多</Button> : null}
    {!loading && items.length === 0 && !error ? <Text>暂无可找换物品</Text> : null}
  </View>;
}

export default DiscoverItemsPage;
