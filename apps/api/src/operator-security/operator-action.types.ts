import { createHash } from 'node:crypto';
import type { OperatorAction, OperatorCapability } from '@barter/contracts';
import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';

export interface OperatorActionContext { actor: AuthenticatedUser; sessionId: string; deviceId: string; grantId: string }
export interface ActionBinding { action: OperatorAction; resourceId: string; expectedVersions: Record<string, number>; requestHash: string }
export type OperatorSessionContext = Omit<OperatorActionContext, 'grantId'>;
export function canonicalHash(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
// Callers pass their validated business DTO, never the hash from the grant request.
export function operatorRequestHash(input: Record<string, unknown>): string {
  return canonicalHash(Object.fromEntries(Object.entries(input).filter(([key]) => !['password', 'grantId', 'sessionId', 'operatorAction', 'operatorActionContext'].includes(key))));
}
export function actionCapability(action: OperatorAction): OperatorCapability {
  return ['UNFREEZE_TRADING', 'APPROVE_FUNDS', 'EXECUTE_FUNDS', 'RESUME_ORDER', 'APPROVE_DEVICE', 'REVOKE_DEVICE'].includes(action) ? 'DESKTOP_PRIVILEGED' : 'MOBILE_LIMITED';
}
export function assertActionRole(actor: AuthenticatedUser, action: OperatorAction): void {
  const riskAction = ['FREEZE_TRADING', 'UNFREEZE_TRADING', 'UNPUBLISH_ITEM', 'HOLD_ORDER'].includes(action);
  const permitted = actor.roles.includes('SUPER_ADMIN') || (riskAction && actor.roles.includes('REVIEWER'));
  if (!permitted) throw new ForbiddenException('Current role cannot perform this action');
}
export function deviceView(device: { id: string; version: number; capability: string; status: string; createdAt: Date; approvedAt: Date | null; revokedAt: Date | null }) {
  const { id, version, capability, status, createdAt, approvedAt, revokedAt } = device;
  return { id, version, capability, status, createdAt: createdAt.toISOString(), approvedAt: approvedAt?.toISOString() ?? null, revokedAt: revokedAt?.toISOString() ?? null };
}
