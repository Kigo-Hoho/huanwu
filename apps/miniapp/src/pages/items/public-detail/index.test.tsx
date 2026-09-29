import type { PublicItemView } from '@barter/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PublicItemDetailPage } from './index';

const item: PublicItemView = {
  id: '00000000-0000-4000-8000-000000000001', ownerId: '00000000-0000-4000-8000-000000000002',
  title: '九成新双肩包', description: '拉链和内衬完好', referenceValueFen: 12000, condition: 'GOOD',
  imageUrls: ['https://example.test/1.jpg'], wantedText: '咖啡机', status: 'ACTIVE', version: 2,
  availableForProposal: false, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
};

describe('public item detail', () => {
  it('shows safe item content and unavailable state', async () => {
    render(<PublicItemDetailPage itemId={item.id} api={{ getPublicItem: vi.fn().mockResolvedValue(item) }} />);
    expect(await screen.findByText('九成新双肩包')).toBeVisible();
    expect(screen.getByText('拉链和内衬完好')).toBeVisible();
    expect(screen.getByText('暂不可投')).toBeVisible();
  });
});
