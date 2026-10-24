import { z } from 'zod';
import { NetCompensationSchema, ResolutionCommandSchema } from './after-sales.js';
export const CompensationStatusSchema = z.enum(['PENDING', 'AUTHORIZED', 'COLLECTED', 'TRANSFERRING', 'TRANSFERRED', 'REFUNDING', 'REFUNDED', 'CLOSED', 'UNKNOWN', 'FAILED']);
export const CompensationFinancialEntryTypeSchema = z.enum(['COLLECTION', 'TRANSFER', 'REFUND']);
export const CompensationPaymentSchema = z.strictObject({ ...ResolutionCommandSchema.shape, obligationId: z.string().uuid().toLowerCase() });
export const CompensationViewSchema = z.strictObject({
  id: z.string().uuid().toLowerCase(), ...NetCompensationSchema.shape, currency: z.literal('CNY'),
  status: CompensationStatusSchema, paymentDeadline: z.iso.datetime(),
}).refine(v => v.amountFen > 0 && v.payer !== 'NONE', 'Compensation obligations require positive payment');
export type CompensationStatus = z.infer<typeof CompensationStatusSchema>;
export type CompensationFinancialEntryType = z.infer<typeof CompensationFinancialEntryTypeSchema>;
export type CompensationPaymentInput = z.infer<typeof CompensationPaymentSchema>;
export type CompensationView = z.infer<typeof CompensationViewSchema>;
