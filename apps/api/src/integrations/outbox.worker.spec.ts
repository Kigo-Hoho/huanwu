import { afterEach, expect, it, vi } from 'vitest';
import { OutboxWorker } from './outbox.worker.js';
import { OutboxHandlerRegistry } from './outbox-handler.registry.js';
import { SystemClock } from '../common/clock.js';
import type { PrismaService } from '../database/prisma.service.js';

afterEach(() => vi.useRealTimers());
it('polls once per second and stops polling after lifecycle shutdown', async () => {
  vi.useFakeTimers();
  let claims = 0;
  const prisma = { $queryRaw: async () => { claims++; return []; } } as unknown as PrismaService;
  const worker = new OutboxWorker(prisma, new SystemClock(), new OutboxHandlerRegistry());
  worker.onModuleInit(); worker.onModuleInit();
  await vi.advanceTimersByTimeAsync(999); expect(claims).toBe(0);
  await vi.advanceTimersByTimeAsync(1); expect(claims).toBe(1);
  await vi.advanceTimersByTimeAsync(1000); expect(claims).toBe(2);
  await worker.onModuleDestroy(); await vi.advanceTimersByTimeAsync(5000);
  expect(claims).toBe(2); expect(vi.getTimerCount()).toBe(0);
});
