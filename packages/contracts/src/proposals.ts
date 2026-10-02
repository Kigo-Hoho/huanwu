import { z } from 'zod';
import { CreateItemSchema } from './items.js';

const uuid = z.string().uuid().toLowerCase();
const positiveVersion = z.number().int().positive();
const fen = z.number().int().min(0).max(2_147_483_647);
export const ProposalStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'CONVERTED']);
export const ProposalSideSchema = z.enum(['INITIATOR', 'RECIPIENT']);
export const ProposalPayerSchema = z.enum(['NONE', 'INITIATOR', 'RECIPIENT']);
export const DeliveryModeSchema = z.enum(['COURIER', 'IN_PERSON']);
export const ProposalIdempotencyKeySchema = z.string().trim().min(1).max(200);

const termsShape = {
  differenceFen: fen.max(20_000), payer: ProposalPayerSchema,
  deliveryMode: DeliveryModeSchema, initiatorShippingFen: fen, recipientShippingFen: fen,
};
type Terms = { differenceFen: number; payer: string; deliveryMode: string; initiatorShippingFen: number; recipientShippingFen: number };
function validTerms(value: Terms) {
  return (value.differenceFen === 0 ? value.payer === 'NONE' : value.payer !== 'NONE') &&
    (value.deliveryMode !== 'IN_PERSON' || (value.initiatorShippingFen === 0 && value.recipientShippingFen === 0));
}
export const ProposalTermsSchema = z.strictObject(termsShape).refine(validTerms, 'Invalid payer or shipping terms');
const offerShape = { offeredItemIds: z.array(uuid).min(1).max(5), targetItemId: uuid, ...termsShape };
function distinctItems(value: { offeredItemIds: string[]; targetItemId: string }) {
  return new Set([...value.offeredItemIds, value.targetItemId]).size === value.offeredItemIds.length + 1;
}
export const CreateProposalSchema = z.strictObject(offerShape)
  .refine(distinctItems, 'Items must be distinct').refine(validTerms, 'Invalid payer or shipping terms');
export const CounterProposalSchema = z.strictObject({ ...offerShape, expectedVersion: positiveVersion })
  .refine(distinctItems, 'Items must be distinct').refine(validTerms, 'Invalid payer or shipping terms');
export const AcceptProposalSchema = z.strictObject({ expectedVersion: positiveVersion });
export const RejectProposalSchema = AcceptProposalSchema;
export const CancelProposalSchema = AcceptProposalSchema;

// Explicit projection prevents private moderation/identity fields crossing the public boundary.
export const PublicItemViewSchema = CreateItemSchema.extend({
  id: uuid, ownerId: uuid, status: z.literal('ACTIVE'), version: positiveVersion,
  availableForProposal: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const PublicItemListSchema = z.object({ items: z.array(PublicItemViewSchema), nextCursor: z.string().nullable() });
export const ProposalItemSnapshotSchema = CreateItemSchema.extend({
  itemId: uuid, ownerId: uuid, itemVersion: positiveVersion,
});
export const ProposalVersionViewSchema = z.object({
  id: uuid, number: positiveVersion, authorId: uuid, createdAt: z.iso.datetime(),
  offeredItems: z.array(ProposalItemSnapshotSchema).min(1).max(5),
  targetItem: ProposalItemSnapshotSchema, ...termsShape,
}).refine(validTerms, 'Invalid payer or shipping terms');
export const ProposalViewSchema = z.object({
  id: uuid, initiatorId: uuid, recipientId: uuid, responderId: uuid,
  status: ProposalStatusSchema, version: positiveVersion, currentVersion: positiveVersion,
  expiresAt: z.iso.datetime(), confirmedAt: z.iso.datetime().nullable(), reservationExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  versions: z.array(ProposalVersionViewSchema).min(1),
  orderId: uuid.nullable().optional(),
}).refine(value => value.status !== 'CONVERTED' || value.orderId != null, 'Converted proposals require an order ID');
export type PublicItemView = z.infer<typeof PublicItemViewSchema>;
export type PublicItemList = z.infer<typeof PublicItemListSchema>;
export type CreateProposalInput = z.infer<typeof CreateProposalSchema>;
export type CounterProposalInput = z.infer<typeof CounterProposalSchema>;
export type ProposalCommandInput = z.infer<typeof AcceptProposalSchema>;
export type ProposalTerms = z.infer<typeof ProposalTermsSchema>;
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export type ProposalSide = z.infer<typeof ProposalSideSchema>;
export type ProposalPayer = z.infer<typeof ProposalPayerSchema>;
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;
export type ProposalItemSnapshot = z.infer<typeof ProposalItemSnapshotSchema>;
export type ProposalVersionView = z.infer<typeof ProposalVersionViewSchema>;
export type ProposalView = z.infer<typeof ProposalViewSchema>;
