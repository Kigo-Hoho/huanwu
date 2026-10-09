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
it('validates strict stable pagination and view-only envelopes', () => {
  const input = schema('OperatorSecurityListInputSchema');
  expect(input.parse({})).toEqual({ limit: 20 });
  expect(input.parse({ limit: '50', cursor: `2026-10-08T12:00:00.000Z~${id}` })).toEqual({ limit: 50, cursor: `2026-10-08T12:00:00.000Z~${id}` });
  for (const change of [{ limit: 0 }, { limit: '51' }, { limit: '' }, { limit: 1.5 }, { cursor: 'bad' }, { actorId: id }]) expect(input.safeParse(change).success).toBe(false);
  const devices = schema('OperatorDeviceListResultSchema');
  const sessions = schema('OperatorSessionListResultSchema');
  for (const result of [devices, sessions]) {
    expect(result.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(result.safeParse([]).success).toBe(false);
    expect(result.safeParse({ items: [], nextCursor: null, credentialDigest: 'private' }).success).toBe(false);
    expect(result.safeParse({ items: [], nextCursor: 'bad' }).success).toBe(false);
  }
});
