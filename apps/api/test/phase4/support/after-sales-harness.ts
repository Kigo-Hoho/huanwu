import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import request from 'supertest';
import { vi } from 'vitest';
import { AuditService } from '../../../src/audit/audit.service.js';
import type { AuthenticatedUser } from '../../../src/auth/auth.service.js';
import type { Prisma } from '../../../src/generated/prisma/client.js';
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
    const origin = 'http://localhost:5173';
    async function operatorLogin(actor = additional.superAdminOne, cookie?: string) {
      const credential = await owned.prisma.adminCredential.findUniqueOrThrow({ where: { userId: actor.id } });
      const call = request(owned.app.getHttpServer()).post('/api/admin/security/login').set('Origin', origin);
      if (cookie) call.set('Cookie', cookie);
      const response = await call.send({ email: credential.email, password });
      return { response, token: response.body.accessToken as string, cookie: (response.headers['set-cookie'] as unknown as string[] | undefined)?.map(value => value.split(';')[0]).join('; ') ?? '' };
    }
    function securityCommand(session: Awaited<ReturnType<typeof operatorLogin>>, path: string, input: object) {
      return request(owned.app.getHttpServer()).post(`/api/admin/security/${path}`).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', origin).set('Idempotency-Key', randomUUID()).send(input);
    }
    return {
      ...owned, actors: { ...owned.actors, ...additional }, operatorPassword: password,
      operatorLogin, securityCommand,
      faultAuditActionAfterInsertOnce(action: string, inspectInserted: (tx: Prisma.TransactionClient) => Promise<void>) {
        const audit = owned.app.get(AuditService); const original = audit.record.bind(audit);
        let armed = true;
        vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
          const inserted = await original(tx, entry);
          if (armed && entry.action === action) {
            armed = false;
            await inspectInserted(tx);
            throw new Error('Injected action-targeted audit failure after insert');
          }
          return inserted;
        });
      },
      enrollOwnedDevice: (session: Awaited<ReturnType<typeof operatorLogin>>) => securityCommand(session, 'devices', {}),
      grant: (session: Awaited<ReturnType<typeof operatorLogin>>, input: object) => securityCommand(session, 'grants', { password, ...input }),
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
