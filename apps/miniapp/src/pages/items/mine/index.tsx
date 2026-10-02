import type { ItemStatus, ItemView } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState, type ComponentProps } from 'react';

import type { IdentityCodeProvider } from '../../../features/auth/identity-code.provider';
import { defaultApiClient, defaultIdentityProvider } from '../../../lib/default-services';

interface MyItemsApi {
  authenticate?(identityProvider: IdentityCodeProvider): Promise<void>;
  listMyItems(): Promise<ItemView[]>;
}

const sections: Array<{ status: Exclude<ItemStatus, 'UNPUBLISHED'>; label: string }> = [
  { status: 'DRAFT', label: '草稿' },
  { status: 'PENDING_REVIEW', label: '等待审核' },
  { status: 'ACTIVE', label: '已上架' },
  { status: 'REJECTED', label: '审核未通过' },
];
const alertRole = { role: 'alert' } as unknown as ComponentProps<typeof Text>;
const headingRole = {
  role: 'heading',
  'aria-level': 2,
} as unknown as ComponentProps<typeof Text>;
const buttonRole = { role: 'button' } as unknown as ComponentProps<typeof Button>;

function defaultNavigateToEdit(itemId: string): void {
  void Taro.navigateTo({ url: `/pages/items/create/index?id=${encodeURIComponent(itemId)}` });
}

function defaultNavigateToDetail(url: string): void {
  void Taro.navigateTo({ url });
}

export function MyItemsPage({
  api = defaultApiClient,
  identityProvider = defaultIdentityProvider,
  navigateToEdit = defaultNavigateToEdit,
  navigateToDetail = defaultNavigateToDetail,
}: {
  api?: MyItemsApi;
  identityProvider?: IdentityCodeProvider;
  navigateToEdit?: (itemId: string) => void;
  navigateToDetail?: (url: string) => void;
}) {
  const [items, setItems] = useState<ItemView[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await api.authenticate?.(identityProvider);
        const ownedItems = await api.listMyItems();
        if (active) setItems(ownedItems);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '加载物品失败。');
      }
    })();
    return () => {
      active = false;
    };
  }, [api, identityProvider]);

  return (
    <View>
      {error ? <Text {...alertRole}>{error}</Text> : null}
      {sections.map((section) => (
        <View key={section.status}>
          <Text {...headingRole}>{section.label}</Text>
          {items
            .filter(({ status }) => status === section.status)
            .map((item) => (
              <View key={item.id}>
                <Text>{item.title}</Text>
                <Text>￥{(item.referenceValueFen / 100).toFixed(2)}</Text>
                <Button
                  {...buttonRole}
                  onClick={() =>
                    navigateToDetail(
                      `/pages/items/detail/index?id=${encodeURIComponent(item.id)}`,
                    )
                  }
                >
                  查看 {item.title}
                </Button>
                {item.status === 'REJECTED' ? (
                  <View>
                    <Text>{item.rejectReason ?? '未提供原因'}</Text>
                    <Button {...buttonRole} onClick={() => navigateToEdit(item.id)}>
                      编辑 {item.title}
                    </Button>
                  </View>
                ) : null}
              </View>
            ))}
        </View>
      ))}
    </View>
  );
}

export default MyItemsPage;
