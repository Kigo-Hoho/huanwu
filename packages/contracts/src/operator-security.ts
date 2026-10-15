import { z } from 'zod';
const uuid = z.string().uuid().toLowerCase();
const time = z.iso.datetime();
export const OperatorCapabilitySchema = z.enum(['MOBILE_LIMITED', 'DESKTOP_PRIVILEGED']);
export const OperatorDeviceStatusSchema = z.enum(['PENDING', 'APPROVED', 'REVOKED']);
export const OperatorActionSchema = z.enum(['FREEZE_TRADING', 'UNFREEZE_TRADING', 'UNPUBLISH_ITEM', 'HOLD_ORDER', 'CLEAR_ITEM_RISK', 'CLEAR_ORDER_RISK', 'RESUME_ORDER', 'APPROVE_FUNDS', 'EXECUTE_FUNDS', 'ADJUDICATE_RESOLUTION', 'APPROVE_DEVICE', 'REVOKE_DEVICE']);
// This DTO carries references only. Actor, device and capability are rehydrated
// by the API and cannot be supplied through a business command.
export const OperatorActionContextSchema = z.strictObject({ sessionId: uuid, grantId: uuid });
export const OperatorExpectedVersionsSchema = z.record(z.string().regex(/^(expected[A-Za-z]*Version|resolutionVersion)$/), z.number().int().positive()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 10);
export const ActionGrantRequestSchema = z.strictObject({ action: OperatorActionSchema, resourceId: uuid, expectedVersions: OperatorExpectedVersionsSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(1).max(500) });
export const OperatorDeviceViewSchema = z.strictObject({ id: uuid, version: z.number().int().positive(), capability: OperatorCapabilitySchema, status: OperatorDeviceStatusSchema, createdAt: time, approvedAt: time.nullable(), revokedAt: time.nullable() });
export const OperatorDeviceCommandSchema = z.strictObject({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), operatorAction: OperatorActionContextSchema });
export const OperatorDeviceEnrollmentSchema = z.strictObject({});
export const OperatorSessionRevokeSchema = z.strictObject({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) });
export const OperatorSessionViewSchema = z.strictObject({ id: uuid, version: z.number().int().positive(), deviceId: uuid, capability: OperatorCapabilitySchema, expiresAt: time });
export const OperatorSecurityCursorSchema = z.string().max(80).refine(value => {
  const [createdAt, id, ...extra] = value.split('~');
  const milliseconds = Date.parse(createdAt);
  return extra.length === 0 && time.safeParse(createdAt).success && Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === createdAt && uuid.safeParse(id).success && id === id.toLowerCase();
}, 'Invalid operator security cursor');
export const OperatorSecurityListInputSchema = z.strictObject({
  cursor: OperatorSecurityCursorSchema.optional(),
  limit: z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)]).pipe(z.number().int().min(1).max(50)).default(20),
});
export const OperatorDeviceListResultSchema = z.strictObject({ items: z.array(OperatorDeviceViewSchema).max(50), nextCursor: OperatorSecurityCursorSchema.nullable() });
export const OperatorSessionListResultSchema = z.strictObject({ items: z.array(OperatorSessionViewSchema).max(50), nextCursor: OperatorSecurityCursorSchema.nullable() });
export const ActionGrantViewSchema = z.strictObject({ id: uuid, action: OperatorActionSchema, resourceId: uuid, expectedVersions: OperatorExpectedVersionsSchema, expiresAt: time });
export const OperatorLoginRequestSchema = z.strictObject({ email: z.email().trim().toLowerCase(), password: z.string().min(1).max(500) });
export const OperatorLoginResultSchema = z.strictObject({ accessToken: z.string().min(1), expiresIn: z.number().int().positive(), user: z.strictObject({ id: uuid, roles: z.array(z.enum(['OPERATIONS', 'REVIEWER', 'SUPER_ADMIN'])).min(1) }), operatorSession: OperatorSessionViewSchema });
export type OperatorCapability = z.infer<typeof OperatorCapabilitySchema>;
export type OperatorDeviceStatus = z.infer<typeof OperatorDeviceStatusSchema>;
export type OperatorAction = z.infer<typeof OperatorActionSchema>;
export type OperatorActionContext = z.infer<typeof OperatorActionContextSchema>;
export type ActionGrantRequest = z.infer<typeof ActionGrantRequestSchema>;
export type OperatorDeviceView = z.infer<typeof OperatorDeviceViewSchema>;
export type OperatorSessionView = z.infer<typeof OperatorSessionViewSchema>;
export type ActionGrantView = z.infer<typeof ActionGrantViewSchema>;
export type OperatorLoginRequest = z.infer<typeof OperatorLoginRequestSchema>;
export type OperatorLoginResult = z.infer<typeof OperatorLoginResultSchema>;
export type OperatorDeviceCommand = z.infer<typeof OperatorDeviceCommandSchema>;
export type OperatorSessionRevoke = z.infer<typeof OperatorSessionRevokeSchema>;
export type OperatorSecurityListInput = z.infer<typeof OperatorSecurityListInputSchema>;
export type OperatorDeviceListResult = z.infer<typeof OperatorDeviceListResultSchema>;
export type OperatorSessionListResult = z.infer<typeof OperatorSessionListResultSchema>;
