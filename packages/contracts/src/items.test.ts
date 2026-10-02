import { describe, expect, it } from 'vitest';
import { CreateItemSchema, ReviewItemSchema } from './items.js';

describe('CreateItemSchema', () => {
  it('stores money as integer fen and requires three images', () => {
    const result = CreateItemSchema.safeParse({
      title: '九成新连衣裙',
      description: '袖口有轻微使用痕迹，已拍照展示',
      referenceValueFen: 20000,
      condition: 'GOOD',
      imageUrls: ['https://img/1', 'https://img/2', 'https://img/3'],
      wantedText: '希望交换通勤包',
    });

    expect(result.success).toBe(true);
  });

  it('rejects decimal fen and fewer than three images', () => {
    expect(CreateItemSchema.safeParse({
      title: '连衣裙',
      description: '描述充分',
      referenceValueFen: 1.5,
      condition: 'GOOD',
      imageUrls: ['https://img/1'],
      wantedText: '',
    }).success).toBe(false);
  });
});

describe('ReviewItemSchema', () => {
  it('requires a reason when rejecting', () => {
    expect(ReviewItemSchema.safeParse({ decision: 'REJECT', expectedVersion: 1 }).success).toBe(false);
  });
});
