import { z } from 'zod';
const uuid = z.string().uuid().toLowerCase();
const time = z.iso.datetime();
export const OperatorCapabilitySchema = z.enum(['MOBILE_LIMITED', 'DESKTOP_PRIVILEGED']);
export const OperatorDeviceStatusSchema = z.enum(['PENDING', 'APPROVED', 'REVOKED']);
export const OperatorActionSchema = z.enum(['FREEZE_TRADING', 'UNFREEZE_TRADING', 'UNPUBLISH_ITEM', 'HOLD_ORDER', 'RESUME_ORDER', 'APPROVE_FUNDS', 'EXECUTE_FUNDS', 'APPROVE_DEVICE', 'REVOKE_DEVICE']);
// This DTO carries references only. Actor, device and capability are rehydrated
// by the API and cannot be supplied through a business command.
export const OperatorActionContextSchema = z.strictObject({ sessionId: uuid, grantId: uuid });
export const ActionGrantRequestSchema = z.strictObject({ action: OperatorActionSchema, resourceId: uuid, expectedVersion: z.number().int().positive(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(1).max(500) });
export const OperatorDeviceViewSchema = z.strictObject({ id: uuid, capability: OperatorCapabilitySchema, status: OperatorDeviceStatusSchema, createdAt: time, approvedAt: time.nullable(), revokedAt: time.nullable() });
export const OperatorSessionViewSchema = z.strictObject({ id: uuid, deviceId: uuid, capability: OperatorCapabilitySchema, expiresAt: time });
export const ActionGrantViewSchema = z.strictObject({ id: uuid, action: OperatorActionSchema, resourceId: uuid, expectedVersion: z.number().int().positive(), expiresAt: time });
export type OperatorCapability = z.infer<typeof OperatorCapabilitySchema>;
export type OperatorDeviceStatus = z.infer<typeof OperatorDeviceStatusSchema>;
export type OperatorAction = z.infer<typeof OperatorActionSchema>;
export type OperatorActionContext = z.infer<typeof OperatorActionContextSchema>;
export type ActionGrantRequest = z.infer<typeof ActionGrantRequestSchema>;
export type OperatorDeviceView = z.infer<typeof OperatorDeviceViewSchema>;
export type OperatorSessionView = z.infer<typeof OperatorSessionViewSchema>;
export type ActionGrantView = z.infer<typeof ActionGrantViewSchema>;
