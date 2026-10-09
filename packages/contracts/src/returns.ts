import { z } from 'zod';
import { OrderSideSchema } from './orders.js';
import { ResolutionCommandSchema } from './after-sales.js';
const uuid = z.string().uuid().toLowerCase();
const time = z.iso.datetime();
export const ReturnStatusSchema = z.enum(['PENDING', 'REGISTERED', 'COLLECTED', 'DELIVERED', 'CONFIRMED', 'DISPUTED', 'INTERCEPTED', 'UNRETURNABLE', 'UNKNOWN']);
export const ReturnShipmentSchema = z.strictObject({
  ...ResolutionCommandSchema.shape, obligationIds: z.array(uuid).min(1).max(5).refine(ids => new Set(ids).size === ids.length),
  carrier: z.string().trim().min(2).max(32).toUpperCase(), trackingNumber: z.string().trim().min(3).max(64).toUpperCase(),
});
export const ReturnHandoverSchema = z.strictObject({ ...ResolutionCommandSchema.shape, obligationIds: z.array(uuid).min(1).max(5).refine(ids => new Set(ids).size === ids.length) });
export const ReturnConfirmSchema = z.strictObject({ ...ResolutionCommandSchema.shape, obligationId: uuid, decision: z.enum(['CONFIRM', 'DISPUTE']), reason: z.string().trim().min(1).max(2000).optional() })
  .refine(v => v.decision !== 'DISPUTE' || Boolean(v.reason), 'Return objection requires a reason');
export const ReturnViewSchema = z.strictObject({
  id: uuid, itemSnapshotId: uuid, holderSide: OrderSideSchema, ownerSide: OrderSideSchema, status: ReturnStatusSchema,
  registrationDeadline: time, receiptDeadline: time.nullable(), confirmedAt: time.nullable(),
}).refine(v => v.holderSide !== v.ownerSide, 'Return must restore the original owner');
export type ReturnStatus = z.infer<typeof ReturnStatusSchema>;
export type ReturnShipmentInput = z.infer<typeof ReturnShipmentSchema>;
export type ReturnHandoverInput = z.infer<typeof ReturnHandoverSchema>;
export type ReturnConfirmInput = z.infer<typeof ReturnConfirmSchema>;
export type ReturnView = z.infer<typeof ReturnViewSchema>;
