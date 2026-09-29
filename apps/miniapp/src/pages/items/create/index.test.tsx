import type { ItemView } from '@barter/contracts';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CreateItemPage, yuanToFen } from './index';

const pendingItem: ItemView = {
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
  wantedText: '交换同价位家居用品',
  status: 'PENDING_REVIEW',
  version: 2,
  rejectReason: null,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:01:00.000Z',
};

function createDependencies() {
  return {
    api: {
      authenticate: vi
        .fn()
        .mockImplementation(async (provider: { getCode(): Promise<string> }) => provider.getCode()),
      createItem: vi.fn().mockResolvedValue({ ...pendingItem, status: 'DRAFT', version: 1 }),
      getMyItem: vi.fn(),
      updateItem: vi.fn().mockResolvedValue({ ...pendingItem, status: 'DRAFT', version: 2 }),
      submitItem: vi.fn().mockResolvedValue(pendingItem),
    },
    imageUpload: {
      upload: vi
        .fn()
        .mockImplementation(async (path: string) => `https://images.example.test/${path.slice(-1)}.jpg`),
    },
    identityProvider: { getCode: vi.fn().mockResolvedValue('customer-code') },
    chooseImages: vi.fn().mockResolvedValue(['local-1', 'local-2', 'local-3']),
    createIdempotencyKey: () => 'submit-item-test-key',
  };
}

describe('create item page', () => {
  it('offers a find-swap entry from the starting page', () => {
    const navigateToDiscover = vi.fn();
    render(<CreateItemPage dependencies={createDependencies()} navigateToDiscover={navigateToDiscover} />);
    expect(screen.queryByRole('button', { name: '找换' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '找换' }));
    expect(navigateToDiscover).toHaveBeenCalledOnce();
  });
  it('blocks submission until three images and required fields are present', async () => {
    render(<CreateItemPage dependencies={createDependencies()} />);
    fireEvent.input(screen.getByLabelText('物品名称'), {
      target: { value: '九成新连衣裙' },
    });
    fireEvent.input(screen.getByLabelText('物品描述'), {
      target: { value: '袖口轻微使用痕迹，照片已展示' },
    });
    expect(screen.getByRole('button', { name: '保存并提交审核' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('authenticates, uploads selected files, creates a draft, and submits it with one command key', async () => {
    const dependencies = createDependencies();
    render(<CreateItemPage dependencies={dependencies} />);

    fireEvent.input(screen.getByLabelText('物品名称'), {
      target: { value: '九成新连衣裙' },
    });
    fireEvent.input(screen.getByLabelText('物品描述'), {
      target: { value: '袖口轻微使用痕迹，照片已经完整展示。' },
    });
    fireEvent.input(screen.getByLabelText('参考价值（元）'), {
      target: { value: '123.45' },
    });
    expect((screen.getByLabelText('物品名称') as HTMLInputElement).value).toBe('九成新连衣裙');
    expect((screen.getByLabelText('物品描述') as HTMLInputElement).value).toBe(
      '袖口轻微使用痕迹，照片已经完整展示。',
    );
    expect((screen.getByLabelText('参考价值（元）') as HTMLInputElement).value).toBe('123.45');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    });
    expect(screen.getByText('已选择 3 / 9 张')).toBeVisible();
    const submit = screen.getByRole('button', { name: '保存并提交审核' });
    expect(submit.getAttribute('aria-disabled')).toBe('false');
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(screen.getByText('等待平台审核')).toBeVisible();
    expect(dependencies.identityProvider.getCode).toHaveBeenCalledTimes(1);
    expect(dependencies.imageUpload.upload).toHaveBeenCalledTimes(3);
    expect(dependencies.api.createItem).toHaveBeenCalledWith({
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
    });
    expect(dependencies.api.submitItem).toHaveBeenCalledWith(
      pendingItem.id,
      'submit-item-test-key',
    );
  });

  it('validates with the shared schema before authentication or upload', async () => {
    const dependencies = createDependencies();
    render(<CreateItemPage dependencies={dependencies} />);

    fireEvent.input(screen.getByLabelText('物品名称'), { target: { value: '短' } });
    fireEvent.input(screen.getByLabelText('物品描述'), { target: { value: '也短' } });
    fireEvent.input(screen.getByLabelText('参考价值（元）'), { target: { value: '0.99' } });
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));

    expect(screen.getByRole('button', { name: '保存并提交审核' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(dependencies.api.authenticate).not.toHaveBeenCalled();
    expect(dependencies.imageUpload.upload).not.toHaveBeenCalled();
  });

  it('retries a lost submit response with the same draft, uploads, and command key', async () => {
    const dependencies = createDependencies();
    dependencies.createIdempotencyKey = vi.fn(() => 'logical-submit-key');
    dependencies.api.submitItem
      .mockRejectedValueOnce(new Error('提交已处理但响应丢失'))
      .mockResolvedValueOnce(pendingItem);
    render(<CreateItemPage dependencies={dependencies} />);

    fireEvent.input(screen.getByLabelText('物品名称'), {
      target: { value: '九成新连衣裙' },
    });
    fireEvent.input(screen.getByLabelText('物品描述'), {
      target: { value: '袖口轻微使用痕迹，照片已经完整展示。' },
    });
    fireEvent.input(screen.getByLabelText('参考价值（元）'), {
      target: { value: '123.45' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    });
    const submit = screen.getByRole('button', { name: '保存并提交审核' });

    await act(async () => {
      fireEvent.click(submit);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('提交已处理但响应丢失');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存并提交审核' }));
    });

    expect(screen.getByText('等待平台审核')).toBeVisible();
    expect(dependencies.imageUpload.upload).toHaveBeenCalledTimes(3);
    expect(dependencies.api.createItem).toHaveBeenCalledTimes(1);
    expect(dependencies.createIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(dependencies.api.submitItem).toHaveBeenNthCalledWith(
      1,
      pendingItem.id,
      'logical-submit-key',
    );
    expect(dependencies.api.submitItem).toHaveBeenNthCalledWith(
      2,
      pendingItem.id,
      'logical-submit-key',
    );
  });

  it('ignores a second submit click while the first request is in flight', async () => {
    const dependencies = createDependencies();
    let finishSubmit: (item: ItemView) => void = () => undefined;
    dependencies.api.submitItem.mockImplementation(
      () => new Promise<ItemView>((resolve) => {
        finishSubmit = resolve;
      }),
    );
    render(<CreateItemPage dependencies={dependencies} />);

    fireEvent.input(screen.getByLabelText('物品名称'), {
      target: { value: '九成新连衣裙' },
    });
    fireEvent.input(screen.getByLabelText('物品描述'), {
      target: { value: '袖口轻微使用痕迹，照片已经完整展示。' },
    });
    fireEvent.input(screen.getByLabelText('参考价值（元）'), {
      target: { value: '123.45' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    });
    const submit = screen.getByRole('button', { name: '保存并提交审核' });

    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dependencies.api.createItem).toHaveBeenCalledTimes(1);
    expect(dependencies.api.submitItem).toHaveBeenCalledTimes(1);
    await act(async () => finishSubmit(pendingItem));
    expect(screen.getByText('等待平台审核')).toBeVisible();
  });

  it('loads a rejected item and updates its draft before resubmitting', async () => {
    const dependencies = createDependencies();
    const rejected = {
      ...pendingItem,
      id: '00000000-0000-4000-8000-000000000099',
      status: 'REJECTED' as const,
      rejectReason: '图片未展示瑕疵位置',
    };
    dependencies.api.getMyItem.mockResolvedValue(rejected);
    dependencies.api.updateItem.mockResolvedValue({ ...rejected, status: 'DRAFT' });

    render(<CreateItemPage dependencies={dependencies} itemId={rejected.id} />);

    await act(async () => Promise.resolve());
    expect(screen.getByDisplayValue(rejected.title)).toBeVisible();
    expect(screen.getByText('已选择 3 / 9 张')).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存并提交审核' }));
    });

    expect(dependencies.api.createItem).not.toHaveBeenCalled();
    expect(dependencies.imageUpload.upload).not.toHaveBeenCalled();
    expect(dependencies.api.updateItem).toHaveBeenCalledWith(rejected.id, {
      title: rejected.title,
      description: rejected.description,
      referenceValueFen: rejected.referenceValueFen,
      condition: rejected.condition,
      imageUrls: rejected.imageUrls,
      wantedText: rejected.wantedText,
    });
    expect(dependencies.api.submitItem).toHaveBeenCalledWith(
      rejected.id,
      'submit-item-test-key',
    );
    expect(screen.getByText('等待平台审核')).toBeVisible();
  });

  it('removes a rejected existing image and uploads its replacement before resubmitting', async () => {
    const dependencies = createDependencies();
    const rejected = {
      ...pendingItem,
      id: '00000000-0000-4000-8000-000000000088',
      status: 'REJECTED' as const,
      rejectReason: '九张图片中第一张与实物不符',
      imageUrls: Array.from(
        { length: 9 },
        (_, index) => `https://images.example.test/wrong-${index + 1}.jpg`,
      ),
    };
    dependencies.api.getMyItem.mockResolvedValue(rejected);
    dependencies.api.updateItem.mockResolvedValue({ ...rejected, status: 'DRAFT' });
    dependencies.chooseImages.mockResolvedValue(['replacement-local']);
    dependencies.imageUpload.upload.mockResolvedValue(
      'https://images.example.test/replacement.jpg',
    );
    render(<CreateItemPage dependencies={dependencies} itemId={rejected.id} />);

    await act(async () => Promise.resolve());
    expect(screen.getByLabelText('已有图片 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '移除已有图片 1' }));
    expect(screen.getByText('已选择 8 / 9 张')).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    });
    expect(screen.getByLabelText('新选图片 1')).toBeVisible();
    expect(screen.getByText('已选择 9 / 9 张')).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存并提交审核' }));
    });

    expect(dependencies.imageUpload.upload).toHaveBeenCalledTimes(1);
    expect(dependencies.api.updateItem).toHaveBeenCalledWith(
      rejected.id,
      expect.objectContaining({
        imageUrls: [
          ...rejected.imageUrls.slice(1),
          'https://images.example.test/replacement.jpg',
        ],
      }),
    );
    expect(screen.getByText('等待平台审核')).toBeVisible();
  });

  it.each([
    ['0.99', 99],
    ['1', 100],
    ['123.45', 12_345],
    ['9999.99', 999_999],
  ])('converts yuan %s to integer fen %i without floating-point arithmetic', (yuan, fen) => {
    expect(yuanToFen(yuan)).toBe(fen);
  });

  it.each(['1.001', '1e2', '-1', 'abc', ''])('rejects unsafe yuan input %s', (yuan) => {
    expect(yuanToFen(yuan)).toBeNull();
  });
});
