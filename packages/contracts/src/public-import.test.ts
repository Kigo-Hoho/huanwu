import { describe, expect, it } from 'vitest';
import { CreateItemSchema } from '@barter/contracts';

describe('@barter/contracts public entry point', () => {
  it('exports item contracts through the package name', () => {
    expect(CreateItemSchema.safeParse({
      title: '通勤双肩包',
      description: '防水尼龙材质，拉链顺滑，内衬干净无破损',
      referenceValueFen: 16800,
      condition: 'GOOD',
      imageUrls: ['https://img/1', 'https://img/2', 'https://img/3'],
      wantedText: '交换轻便外套',
    }).success).toBe(true);
  });
});
