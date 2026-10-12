import type { CaseTx, LockedCase } from './case.types.js';

// Sequential relation loading also works with the Prisma 7 pg transaction
// adapter; do not dispatch sibling queries concurrently on a single client.
export async function readCase(tx: CaseTx, id: string): Promise<LockedCase | null> {
  const value = await tx.afterSalesCase.findUnique({ where: { id } });
  if (!value) return null;
  const records = await tx.caseRecord.findMany({ where: { caseId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const evidence = await tx.caseEvidence.findMany({ where: { caseId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const versions = await tx.resolutionVersion.findMany({ where: { caseId: id }, orderBy: { number: 'asc' } });
  const resolutions: LockedCase['resolutions'] = [];
  for (const resolution of versions) {
    const where = { resolutionId: resolution.id };
    const consents = await tx.resolutionConsent.findMany({ where });
    const approvals = await tx.resolutionApproval.findMany({ where });
    const executions = await tx.resolutionExecution.findMany({ where, include: { progress: true } });
    const returnObligations = await tx.returnObligation.findMany({ where, include: { progress: true } });
    const obligations = await tx.compensationObligation.findMany({ where });
    const compensationObligations: LockedCase['resolutions'][number]['compensationObligations'] = [];
    for (const obligation of obligations) {
      const progress = await tx.compensationProgress.findUnique({ where: { obligationId: obligation.id } });
      const payment = await tx.compensationPayment.findUnique({ where: { obligationId: obligation.id } });
      compensationObligations.push({ ...obligation, progress, payment });
    }
    resolutions.push({ ...resolution, consents, approvals, executions, returnObligations, compensationObligations });
  }
  return { ...value, records, evidence, resolutions };
}
