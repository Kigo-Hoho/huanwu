import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type ReviewApi } from '../../lib/api-client';
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

  it('replaces detail with the authoritative audit history after one rejection', async () => {
    const rejectionReason = '图片模糊，请重新拍摄';
    const rejectedDetail = {
      ...pendingItem,
      status: 'REJECTED' as const,
      version: 4,
      rejectReason: rejectionReason,
      auditHistory: [
        ...pendingItem.auditHistory,
        {
          id: '44444444-4444-4444-8444-444444444444',
          actorId: '55555555-5555-4555-8555-555555555555',
          actor: {
            id: '55555555-5555-4555-8555-555555555555',
            displayName: '审核员周女士',
          },
          action: 'ITEM_REJECTED',
          entityType: 'Item',
          entityId: pendingItem.id,
          reason: rejectionReason,
          requestId: 'request-review-reject',
          before: { status: 'PENDING_REVIEW', version: 3 },
          after: { status: 'REJECTED', version: 4, rejectReason: rejectionReason },
          createdAt: '2026-09-22T10:15:00.000Z',
        },
      ],
    };
    const getReviewItem = vi
      .fn()
      .mockResolvedValueOnce(pendingItem)
      .mockResolvedValueOnce(rejectedDetail);
    const reviewItem = vi.fn().mockResolvedValue(rejectedDetail);
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={['/reviews/11111111-1111-4111-8111-111111111111']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/reviews/:itemId"
            element={
              <ItemReviewPage
                client={api({ getReviewItem, reviewItem })}
                currentRoles={['REVIEWER']}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: pendingItem.title });
    await user.type(screen.getByLabelText('驳回原因'), rejectionReason);
    await user.click(screen.getByRole('button', { name: '驳回物品' }));

    expect(await screen.findByText('REJECTED')).toBeVisible();
    expect(screen.getByText('驳回原因')).toBeVisible();
    expect(screen.getByText(rejectionReason)).toBeVisible();
    const auditHistory = screen.getByRole('region', { name: '审核历史' });
    expect(auditHistory).toHaveTextContent('审核驳回');
    expect(auditHistory).toHaveTextContent(`原因：${rejectionReason}`);
    expect(reviewItem).toHaveBeenCalledOnce();
    expect(getReviewItem).toHaveBeenCalledTimes(2);
  });

  it('keeps the successful decision visible when its detail refresh fails', async () => {
    const getReviewItem = vi
      .fn()
      .mockResolvedValueOnce(pendingItem)
      .mockRejectedValueOnce(
        new ApiError(500, {
          code: 'VALIDATION_FAILED',
          message: 'Detail unavailable',
          requestId: 'request-detail-failed',
        }),
      );
    const reviewItem = vi.fn().mockResolvedValue({
      ...pendingItem,
      status: 'ACTIVE' as const,
      version: 4,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={['/reviews/11111111-1111-4111-8111-111111111111']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/reviews/:itemId"
            element={
              <ItemReviewPage
                client={api({ getReviewItem, reviewItem })}
                currentRoles={['REVIEWER']}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: pendingItem.title });
    await user.click(screen.getByRole('button', { name: '审核通过' }));

    expect(await screen.findByText('ACTIVE')).toBeVisible();
    expect(
      screen.getByText(
        '审核决定已保存，但最新审核详情加载失败：VALIDATION_FAILED：Detail unavailable',
      ),
    ).toBeVisible();
    expect(reviewItem).toHaveBeenCalledOnce();
    expect(getReviewItem).toHaveBeenCalledTimes(2);
  });
});
