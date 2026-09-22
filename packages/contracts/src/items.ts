import { z } from 'zod';

export const ItemStatusSchema = z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'UNPUBLISHED']);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ItemConditionSchema = z.enum(['LIKE_NEW', 'GOOD', 'FAIR']);
export type ItemCondition = z.infer<typeof ItemConditionSchema>;

export const CreateItemSchema = z.object({
  title: z.string().trim().min(4).max(60),
  description: z.string().trim().min(8).max(2000),
  referenceValueFen: z.number().int().min(100).max(1_000_000),
  condition: ItemConditionSchema,
  imageUrls: z.array(z.string().url()).min(3).max(9),
  wantedText: z.string().trim().max(200),
});

export const UpdateItemSchema = CreateItemSchema.partial();
export const ReviewItemSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('APPROVE'), expectedVersion: z.number().int().positive() }),
  z.object({
    decision: z.literal('REJECT'),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(4).max(300),
  }),
]);

export type ItemView = z.infer<typeof CreateItemSchema> & {
  id: string;
  ownerId: string;
  status: ItemStatus;
  version: number;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
};
