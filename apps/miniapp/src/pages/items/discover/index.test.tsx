import type { PublicItemView } from '@barter/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiscoverItemsPage } from './index';

const item: PublicItemView = {
  id: '00000000-0000-4000-8000-000000000001', ownerId: '00000000-0000-4000-8000-000000000002',
  title: '九成新双肩包', description: '描述完整', referenceValueFen: 12000, condition: 'GOOD',
  imageUrls: ['https://example.test/1.jpg'], wantedText: '咖啡机', status: 'ACTIVE', version: 2,
  availableForProposal: false, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
};

describe('public discovery page', () => {
  it('shows reserved items as visible but unavailable and opens the public detail', async () => {
    const navigate = vi.fn();
    const api = { listPublicItems: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }) };
    render(<DiscoverItemsPage api={api} navigateToDetail={navigate} />);
    expect(await screen.findByText('九成新双肩包')).toBeVisible();
    expect(screen.getByText('暂不可投')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看 九成新双肩包' }));
    expect(navigate).toHaveBeenCalledWith(`/pages/items/public-detail/index?id=${item.id}`);
  });

  it('loads the next cursor only when requested', async () => {
    const api = { listPublicItems: vi.fn().mockResolvedValueOnce({ items: [item], nextCursor: 'next-page' }).mockResolvedValueOnce({ items: [], nextCursor: null }) };
    render(<DiscoverItemsPage api={api} navigateToDetail={vi.fn()} />);
    expect(await screen.findByText('九成新双肩包')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(api.listPublicItems).toHaveBeenLastCalledWith('next-page');
  });
});
