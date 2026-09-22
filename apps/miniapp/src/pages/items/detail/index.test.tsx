import type { ItemView } from '@barter/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ItemDetailPage } from './index';

const ownedItem: ItemView = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  title: '九成新连衣裙',
  description: '袖口轻微使用痕迹，照片已经完整展示。',
  referenceValueFen: 12_345,
  condition: 'GOOD',
  imageUrls: [
    'https://images.example.test/1.jpg',
    'https://images.example.test/2.jpg',
    'https://images.example.test/3.jpg',
  ],
  wantedText: '',
  status: 'DRAFT',
  version: 1,
  rejectReason: null,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

describe('owned item detail page', () => {
  it('authenticates with the injected identity and fetches only the owned-item endpoint', async () => {
    const identityProvider = { getCode: vi.fn().mockResolvedValue('customer-code') };
    const api = {
      authenticate: vi
        .fn()
        .mockImplementation(async (provider: typeof identityProvider) => provider.getCode()),
      getMyItem: vi.fn().mockResolvedValue(ownedItem),
    };

    render(
      <ItemDetailPage
        api={api}
        identityProvider={identityProvider}
        itemId={ownedItem.id}
      />,
    );

    expect(await screen.findByText('九成新连衣裙')).toBeVisible();
    expect(identityProvider.getCode).toHaveBeenCalledTimes(1);
    expect(api.getMyItem).toHaveBeenCalledWith(ownedItem.id);
  });
});
