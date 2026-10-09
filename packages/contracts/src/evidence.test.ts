import { expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from './index.js';
const schema = (name: string) => { const s = (contracts as unknown as Record<string, z.ZodType>)[name]; expect(s).toBeDefined(); return s!; };
const id = '00000000-0000-4000-8000-000000000001';
it('bounds evidence descriptions and attachment batches', () => {
  const submit = schema('EvidenceSubmitSchema');
  expect(submit.safeParse({ expectedCaseVersion: 1, expectedOrderVersion: 1, description: '包装照片', imageIds: [id] }).success).toBe(true);
  for (const imageIds of [[], Array(10).fill(id), [id, id]]) expect(submit.safeParse({ expectedCaseVersion: 1, expectedOrderVersion: 1, description: '包装照片', imageIds }).success).toBe(false);
  expect(submit.safeParse({ expectedCaseVersion: 1, expectedOrderVersion: 1, description: '', imageIds: [id] }).success).toBe(false);
});
it('limits decoded evidence dimensions, bytes and MIME', () => {
  const input = { mimeType: 'image/png', bytes: 8388608, width: 8192, height: 100, sha256: 'a'.repeat(64) };
  const metadata = schema('EvidenceImageMetadataSchema');
  expect(metadata.safeParse(input).success).toBe(true);
  for (const change of [{ bytes: 8388609 }, { width: 8193 }, { width: 8192, height: 8192 }, { mimeType: 'image/svg+xml' }]) expect(metadata.safeParse({ ...input, ...change }).success).toBe(false);
});
it('does not expose private object keys or permanent URLs in evidence views', () => {
  const view = { id, uploaderId: id, description: '包装照片', mimeType: 'image/png', bytes: 100, width: 10, height: 10, sha256: 'a'.repeat(64), createdAt: '2026-10-09T00:00:00.000Z' };
  expect(schema('EvidenceViewSchema').safeParse(view).success).toBe(true);
  for (const change of [{ originalKey: 'secret' }, { url: 'https://public/image' }]) expect(schema('EvidenceViewSchema').safeParse({ ...view, ...change }).success).toBe(false);
});
