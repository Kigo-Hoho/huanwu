import { expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from './index.js';
const schema = (name: string) => { const s = (contracts as unknown as Record<string, z.ZodType>)[name]; expect(s).toBeDefined(); return s!; };
const id = '00000000-0000-4000-8000-000000000001';
it('returns only a resource identity and positive version for risk commands', () => {
  const result = schema('RiskCommandResultSchema');
  expect(result.safeParse({ resourceId: id, version: 2 }).success).toBe(true);
  for (const change of [{ version: 0 }, { storageKey: 'secret' }, { reporterId: id }]) expect(result.safeParse({ resourceId: id, version: 2, ...change }).success).toBe(false);
});
it('requires structured report targets and their current version', () => {
  const input = { targetType: 'ITEM', targetId: id, expectedTargetVersion: 1, reason: 'PROHIBITED_ITEM', description: '疑似违规物品' };
  expect(schema('CreateRiskReportSchema').safeParse(input).success).toBe(true);
  for (const change of [{ expectedTargetVersion: 0 }, { targetType: 'USER' }, { reporterId: id }]) expect(schema('CreateRiskReportSchema').safeParse({ ...input, ...change }).success).toBe(false);
});
it('keeps reporter identity out of administrator report summaries', () => {
  const view = { id, targetType: 'ITEM', targetId: id, reason: 'PROHIBITED_ITEM', description: '疑似违规物品', status: 'OPEN', version: 1, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' };
  expect(schema('RiskReportViewSchema').safeParse(view).success).toBe(true);
  expect(schema('AdminRiskReportViewSchema').safeParse({ ...view, reporterId: id }).success).toBe(false);
});
it('binds risk actions and conclusions to strict versioned commands and restoration grants', () => {
  const command = { expectedVersion: 1, reason: '核验原因', operatorAction: { sessionId: id, grantId: id } };
  expect(schema('RiskActionInputSchema').safeParse(command).success).toBe(true);
  expect(schema('RiskActionInputSchema').safeParse({ ...command, status: 'ACTIVE' }).success).toBe(false);
  expect(schema('ConcludeRiskReportSchema').safeParse({ expectedVersion: 1, reason: '核验结论', conclusion: 'ACTIONED' }).success).toBe(true);
  expect(schema('ConcludeRiskReportSchema').safeParse({ expectedVersion: 1, reason: '', conclusion: 'OPEN' }).success).toBe(false);
  expect(schema('OperatorActionSchema').safeParse('CLEAR_ITEM_RISK').success).toBe(true);
  expect(schema('OperatorActionSchema').safeParse('CLEAR_ORDER_RISK').success).toBe(true);
});
