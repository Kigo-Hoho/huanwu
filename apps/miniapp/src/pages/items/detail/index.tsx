import type { ItemView } from '@barter/contracts';
import { Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState, type ComponentProps } from 'react';

import type { IdentityCodeProvider } from '../../../features/auth/identity-code.provider';
import { defaultApiClient, defaultIdentityProvider } from '../../../lib/default-services';

const alertRole = { role: 'alert' } as unknown as ComponentProps<typeof Text>;

interface DetailApi {
  authenticate(identityProvider: IdentityCodeProvider): Promise<void>;
  getMyItem(itemId: string): Promise<ItemView>;
}

export function ItemDetailPage({
  api = defaultApiClient,
  identityProvider = defaultIdentityProvider,
  itemId = Taro.getCurrentInstance().router?.params.id ?? '',
}: {
  api?: DetailApi;
  identityProvider?: IdentityCodeProvider;
  itemId?: string;
}) {
  const [item, setItem] = useState<ItemView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!itemId) {
        setError('缺少物品编号。');
        return;
      }
      try {
        await api.authenticate(identityProvider);
        const ownedItem = await api.getMyItem(itemId);
        if (active) setItem(ownedItem);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '加载物品失败。');
      }
    })();
    return () => {
      active = false;
    };
  }, [api, identityProvider, itemId]);

  if (error) return <View><Text {...alertRole}>{error}</Text></View>;
  if (!item) return <View><Text>加载中</Text></View>;

  return (
    <View>
      <Text>{item.title}</Text>
      <Text>{item.description}</Text>
      <Text>￥{(item.referenceValueFen / 100).toFixed(2)}</Text>
      <Text>{item.status}</Text>
      {item.imageUrls.map((url, index) => (
        <Image
          key={url}
          {...({ alt: `${item.title} 图片 ${index + 1}` } as unknown as ComponentProps<
            typeof Image
          >)}
          src={url}
          mode='aspectFill'
        />
      ))}
    </View>
  );
}

export default ItemDetailPage;
