import { expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from './index.js';
const schema = (name: string) => { const s = (contracts as unknown as Record<string, z.ZodType>)[name]; expect(s).toBeDefined(); return s!; };
const id = '00000000-0000-4000-8000-000000000001';
it('accepts only server-issued session and action grant references', () => {
  expect(schema('OperatorActionContextSchema').safeParse({ sessionId: id, grantId: id }).success).toBe(true);
  for (const change of [{ actorId: id }, { deviceKind: 'DESKTOP_PRIVILEGED' }, { password: 'private' }]) expect(schema('OperatorActionContextSchema').safeParse({ sessionId: id, grantId: id, ...change }).success).toBe(false);
});
it('binds reauthentication to action, resource, version and digest', () => {
  const input = { action: 'APPROVE_FUNDS', resourceId: id, expectedVersions: { expectedCaseVersion: 1, expectedOrderVersion: 2, resolutionVersion: 3 }, requestHash: 'a'.repeat(64), password: 'test-only-password' };
  expect(schema('ActionGrantRequestSchema').safeParse(input).success).toBe(true);
  expect(schema('ActionGrantRequestSchema').safeParse({ ...input, expectedVersions: {} }).success).toBe(false);
  expect(schema('ActionGrantRequestSchema').safeParse({ ...input, requestHash: 'unchecked' }).success).toBe(false);
});
