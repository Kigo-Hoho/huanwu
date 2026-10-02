import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type ReviewApi } from '../../lib/api-client';
import { pendingItem } from '../../test/fixtures';
import { ReviewActions } from './review-actions';

function api(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    listPendingItems: vi.fn(),
    getReviewItem: vi.fn().mockResolvedValue(pendingItem),
    reviewItem: vi.fn().mockResolvedValue({ ...pendingItem, status: 'ACTIVE', version: 4 }),
    ...overrides,
  };
}

describe('review actions', () => {
  it('does not render review actions for operations-only users', () => {
    render(<ReviewActions item={pendingItem} currentRoles={['OPERATIONS']} client={api()} />);
    expect(screen.queryByRole('button', { name: '审核通过' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('驳回原因')).not.toBeInTheDocument();
  });

  it('submits the displayed version and blocks a duplicate decision while pending', async () => {
    let finish!: (value: typeof pendingItem) => void;
    const reviewItem = vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const client = api({ reviewItem });
    const user = userEvent.setup();
    render(<ReviewActions item={pendingItem} currentRoles={['REVIEWER']} client={client} />);

    const approve = screen.getByRole('button', { name: '审核通过' });
    await user.click(approve);
    expect(approve).toBeDisabled();
    await user.click(approve);
    expect(reviewItem).toHaveBeenCalledTimes(1);
    expect(reviewItem).toHaveBeenCalledWith(pendingItem.id, {
      decision: 'APPROVE',
      expectedVersion: 3,
    });
    finish({ ...pendingItem, status: 'ACTIVE', version: 4 });
  });

  it('submits a validated rejection reason', async () => {
    const reviewItem = vi.fn().mockResolvedValue({ ...pendingItem, status: 'REJECTED', version: 4 });
    const user = userEvent.setup();
    render(<ReviewActions item={pendingItem} currentRoles={['SUPER_ADMIN']} client={api({ reviewItem })} />);

    await user.type(screen.getByLabelText('驳回原因'), '图片信息不足');
    await user.click(screen.getByRole('button', { name: '驳回物品' }));
    expect(reviewItem).toHaveBeenCalledWith(pendingItem.id, {
      decision: 'REJECT',
      expectedVersion: 3,
      reason: '图片信息不足',
    });
  });

  it('refreshes a version-conflicted item and shows the required message', async () => {
    const refreshed = { ...pendingItem, status: 'ACTIVE' as const, version: 4 };
    const getReviewItem = vi.fn().mockResolvedValue(refreshed);
    const client = api({
      getReviewItem,
      reviewItem: vi.fn().mockRejectedValue(
        new ApiError(409, {
          code: 'ITEM_VERSION_CONFLICT',
          message: 'Item version has changed',
          requestId: 'request-conflict',
        }),
      ),
    });
    const onItemRefreshed = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewActions
        item={pendingItem}
        currentRoles={['REVIEWER']}
        client={client}
        onItemRefreshed={onItemRefreshed}
      />,
    );

    await user.click(screen.getByRole('button', { name: '审核通过' }));
    expect(await screen.findByText('该物品已被其他审核员处理')).toBeVisible();
    expect(getReviewItem).toHaveBeenCalledOnce();
    expect(onItemRefreshed).toHaveBeenCalledWith(refreshed);
  });

  it('keeps the conflict message visible after the refreshed item is no longer pending', async () => {
    const refreshed = { ...pendingItem, status: 'ACTIVE' as const, version: 4 };
    const client = api({
      getReviewItem: vi.fn().mockResolvedValue(refreshed),
      reviewItem: vi.fn().mockRejectedValue(
        new ApiError(409, {
          code: 'ITEM_VERSION_CONFLICT',
          message: 'Item version has changed',
          requestId: 'request-conflict',
        }),
      ),
    });
    function ConflictHarness() {
      const [item, setItem] = useState(pendingItem);
      return (
        <ReviewActions
          item={item}
          currentRoles={['REVIEWER']}
          client={client}
          onItemRefreshed={setItem}
        />
      );
    }
    const user = userEvent.setup();
    render(<ConflictHarness />);

    await user.click(screen.getByRole('button', { name: '审核通过' }));
    expect(await screen.findByText('该物品已被其他审核员处理')).toBeVisible();
    expect(screen.queryByRole('button', { name: '审核通过' })).not.toBeInTheDocument();
  });

  it('surfaces expired authentication when the conflict refresh is denied', async () => {
    const reviewItem = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: 'ITEM_VERSION_CONFLICT',
        message: 'Item version has changed',
        requestId: 'request-conflict',
      }),
    );
    const getReviewItem = vi.fn().mockRejectedValue(
      new ApiError(401, {
        code: 'AUTH_REQUIRED',
        message: 'Access token has expired',
        requestId: 'request-expired',
      }),
    );
    const user = userEvent.setup();
    render(
      <ReviewActions
        item={pendingItem}
        currentRoles={['REVIEWER']}
        client={api({ reviewItem, getReviewItem })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '审核通过' }));
    expect(await screen.findByText('AUTH_REQUIRED：Access token has expired')).toBeVisible();
    expect(reviewItem).toHaveBeenCalledOnce();
    expect(getReviewItem).toHaveBeenCalledOnce();
  });

  it('surfaces FORBIDDEN without retrying the denied review', async () => {
    const reviewItem = vi.fn().mockRejectedValue(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'Review permission is required',
        requestId: 'request-forbidden',
      }),
    );
    const user = userEvent.setup();
    render(<ReviewActions item={pendingItem} currentRoles={['REVIEWER']} client={api({ reviewItem })} />);

    await user.click(screen.getByRole('button', { name: '审核通过' }));
    expect(await screen.findByText('FORBIDDEN：Review permission is required')).toBeVisible();
    expect(reviewItem).toHaveBeenCalledOnce();
  });
});
