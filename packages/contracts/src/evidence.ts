import { z } from 'zod';
const uuid = z.string().uuid().toLowerCase();
export const EvidenceMimeTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const image = {
  mimeType: EvidenceMimeTypeSchema, bytes: z.number().int().positive().max(8388608),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const EvidenceImageMetadataSchema = z.strictObject(image).refine(v => v.width * v.height <= 40000000, 'Decoded image exceeds pixel limit');
const submit = { description: z.string().trim().min(1).max(2000) };
// File count, content digests and order come from the actual multipart files.
export const EvidenceSubmitSchema = z.strictObject({ expectedCaseVersion: z.number().int().positive(), expectedOrderVersion: z.number().int().positive(), ...submit });
export const ReportEvidenceSubmitSchema = z.strictObject({ expectedVersion: z.number().int().positive(), ...submit });
// Private storage keys and image bytes are never part of generic DTOs.
export const EvidenceViewSchema = z.strictObject({ id: uuid, uploaderId: uuid, description: submit.description, ...image, createdAt: z.iso.datetime() })
  .refine(v => v.width * v.height <= 40000000, 'Decoded image exceeds pixel limit');
export const AdminEvidenceViewSchema = z.strictObject({ id: uuid, description: submit.description, ...image, createdAt: z.iso.datetime() })
  .refine(v => v.width * v.height <= 40000000, 'Decoded image exceeds pixel limit');
export type EvidenceMimeType = z.infer<typeof EvidenceMimeTypeSchema>;
export type EvidenceImageMetadata = z.infer<typeof EvidenceImageMetadataSchema>;
export type EvidenceSubmitInput = z.infer<typeof EvidenceSubmitSchema>;
export type ReportEvidenceSubmitInput = z.infer<typeof ReportEvidenceSubmitSchema>;
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export type AdminEvidenceView = z.infer<typeof AdminEvidenceViewSchema>;
