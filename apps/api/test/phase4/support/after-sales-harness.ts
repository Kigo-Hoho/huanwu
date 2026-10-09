import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { AuthenticatedUser } from '../../../src/auth/auth.service.js';
import { createOrderHarness } from '../../phase3/support/order-harness.js';

// This wrapper retains the tested OrderHarness ownership and close ordering.
// Orders are prepared through existing public proposal/order HTTP commands.
export async function createAfterSalesHarness() {
  const keys = ['NODE_ENV', 'PAYMENT_PROVIDER', 'LOGISTICS_PROVIDER'] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const restore = () => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  process.env.NODE_ENV = 'test'; process.env.PAYMENT_PROVIDER = 'simulated'; process.env.LOGISTICS_PROVIDER = 'simulated';
  let base: Awaited<ReturnType<typeof createOrderHarness>> | undefined;
  try {
    base = await createOrderHarness();
    base.clock.set('2026-10-09T00:00:00.000Z');
    const password = 'phase4-test-only-operator-password';
    const passwordHash = await argon2.hash(password);
    const additional = {} as Record<'operations' | 'reviewer' | 'superAdminOne' | 'superAdminTwo', AuthenticatedUser>;
    for (const name of ['operations', 'reviewer', 'superAdminOne', 'superAdminTwo'] as const) {
      const roles: AuthenticatedUser['roles'] = [name === 'operations' ? 'OPERATIONS' : name === 'reviewer' ? 'REVIEWER' : 'SUPER_ADMIN'];
      const user = await base.prisma.user.create({ data: { roles: { create: roles.map(role => ({ role })) }, adminCredential: { create: { email: `${randomUUID()}@example.test`, passwordHash } } } });
      additional[name] = { id: user.id, roles };
    }
    const owned = base;
    return {
      ...owned, actors: { ...owned.actors, ...additional }, operatorPassword: password,
      async prepareOrder(options: Parameters<typeof owned.confirmedProposal>[0] = {}) {
        const proposal = await owned.confirmedProposal(options);
        return (await owned.convert(proposal).expect(201)).body.order as { id: string; version: number };
      },
      async close() { try { await owned.close(); } finally { restore(); } },
    };
  } catch (error) {
    try { await base?.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'After-sales harness initialization and cleanup failed', { cause: cleanup }); }
    finally { restore(); }
    throw error;
  }
}
export type AfterSalesHarness = Awaited<ReturnType<typeof createAfterSalesHarness>>;
