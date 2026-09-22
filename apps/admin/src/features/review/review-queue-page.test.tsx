import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewApi } from '../../lib/api-client';
import { pendingItem } from '../../test/fixtures';
import { ItemReviewPage } from './item-review-page';
import { ReviewQueuePage } from './review-queue-page';

function api(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    listPendingItems: vi.fn().mockResolvedValue([pendingItem]),
    getReviewItem: vi.fn().mockResolvedValue(pendingItem),
    reviewItem: vi.fn(),
    ...overrides,
  };
}

describe('review queue', () => {
  it('renders the pending queue as a desktop table with review fields', async () => {
    window.innerWidth = 1024;
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ReviewQueuePage client={api()} />
      </MemoryRouter>,
    );

    const table = await screen.findByRole('table', { name: '待审核物品' });
    expect(within(table).getByRole('columnheader', { name: '图片' })).toBeVisible();
    expect(within(table).getByText('九成新手冲咖啡壶')).toBeVisible();
    expect(within(table).getByText('林女士')).toBeVisible();
    expect(within(table).getByText('¥250.80')).toBeVisible();
    expect(within(table).getByText('2026-09-22 09:30:45 UTC')).toBeVisible();
    expect(within(table).getByText('v3')).toBeVisible();
  });

  it('renders stacked review cards below 768px', async () => {
    window.innerWidth = 390;
    fireEvent(window, new Event('resize'));
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ReviewQueuePage client={api()} />
      </MemoryRouter>,
    );

    const list = await screen.findByRole('list', { name: '待审核物品' });
    expect(screen.queryByRole('table', { name: '待审核物品' })).not.toBeInTheDocument();
    expect(within(list).getByRole('article')).toHaveTextContent('¥250.80');
    expect(within(list).getByRole('link', { name: /九成新手冲咖啡壶/ })).toBeVisible();
  });
});

describe('single-item review', () => {
  it('keeps all item evidence and review controls usable at 390px', async () => {
    window.innerWidth = 390;
    fireEvent(window, new Event('resize'));
    render(
      <MemoryRouter
        initialEntries={['/reviews/11111111-1111-4111-8111-111111111111']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/reviews/:itemId"
            element={<ItemReviewPage client={api()} currentRoles={['REVIEWER']} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '九成新手冲咖啡壶' })).toBeVisible();
    expect(screen.getAllByRole('img', { name: /物品图片/ })).toHaveLength(3);
    expect(screen.getByText(pendingItem.description)).toBeVisible();
    expect(screen.getByText('良好')).toBeVisible();
    expect(screen.getByText('希望交换露营灯')).toBeVisible();
    expect(screen.getByRole('region', { name: '审核历史' })).toHaveTextContent('提交审核');
    expect(screen.getByRole('button', { name: '审核通过' })).toBeVisible();
    expect(screen.getByLabelText('驳回原因')).toBeVisible();
  });
});
