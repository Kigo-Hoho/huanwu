import type { OperatorItemDetail } from '../lib/api-client';

export const pendingItem: OperatorItemDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  owner: { id: '22222222-2222-4222-8222-222222222222', displayName: '林女士' },
  title: '九成新手冲咖啡壶',
  description: '壶身有轻微使用痕迹，功能完好，所有细节均已拍摄。',
  referenceValueFen: 25_080,
  condition: 'GOOD',
  imageUrls: [
    'https://images.test/coffee-1.jpg',
    'https://images.test/coffee-2.jpg',
    'https://images.test/coffee-3.jpg',
  ],
  wantedText: '希望交换露营灯',
  status: 'PENDING_REVIEW',
  version: 3,
  rejectReason: null,
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T09:30:45.000Z',
  auditHistory: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      actorId: '22222222-2222-4222-8222-222222222222',
      actor: { id: '22222222-2222-4222-8222-222222222222', displayName: '林女士' },
      action: 'ITEM_SUBMITTED',
      entityType: 'Item',
      entityId: '11111111-1111-4111-8111-111111111111',
      reason: null,
      requestId: 'request-1',
      before: { status: 'DRAFT', version: 2 },
      after: { status: 'PENDING_REVIEW', version: 3 },
      createdAt: '2026-09-22T09:30:45.000Z',
    },
  ],
};
