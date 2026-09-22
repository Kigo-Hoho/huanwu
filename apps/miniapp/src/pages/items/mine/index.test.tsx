import type { ItemStatus, ItemView } from '@barter/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MyItemsPage } from './index';

function item(status: ItemStatus, id: string, rejectReason: string | null = null): ItemView {
  return {
    id,
    ownerId: '00000000-0000-4000-8000-000000000002',
    title: `${status} 物品`,
    description: '这是用于页面状态分组测试的完整物品描述。',
    referenceValueFen: 12_345,
    condition: 'GOOD',
    imageUrls: [
      'https://images.example.test/1.jpg',
      'https://images.example.test/2.jpg',
      'https://images.example.test/3.jpg',
    ],
    wantedText: '',
    status,
    version: 1,
    rejectReason,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  };
}

describe('my items page', () => {
  it('groups the four customer-visible item states', async () => {
    const items = [
      item('DRAFT', 'draft'),
      item('PENDING_REVIEW', 'pending'),
      item('ACTIVE', 'active'),
      item('REJECTED', 'rejected', '图片未展示瑕疵位置'),
    ];
    const api = { listMyItems: vi.fn().mockResolvedValue(items) };

    render(<MyItemsPage api={api} navigateToEdit={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: '草稿' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '等待审核' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '已上架' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '审核未通过' })).toBeVisible();
  });

  it('shows rejected reason and lets the customer edit the rejected item', async () => {
    const rejected = item('REJECTED', 'rejected-item', '图片未展示瑕疵位置');
    const api = { listMyItems: vi.fn().mockResolvedValue([rejected]) };
    const navigateToEdit = vi.fn();

    render(<MyItemsPage api={api} navigateToEdit={navigateToEdit} />);

    expect(await screen.findByText('图片未展示瑕疵位置')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '编辑 REJECTED 物品' }));
    expect(navigateToEdit).toHaveBeenCalledWith('rejected-item');
  });
});
