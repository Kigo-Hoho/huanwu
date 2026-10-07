import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ events: [] as string[], fail: '', source: '', prisma: {} as object }));
vi.mock('./support/database-fixtures.js', () => ({ createPhase3Database: async () => {
  fixture.source = process.env.DATABASE_URL!; process.env.DATABASE_URL = 'owned-test-resource';
  return { url: 'owned-test-resource', close: async () => { fixture.events.push('database'); process.env.DATABASE_URL = fixture.source; if (fixture.fail === 'close') throw Error('database close failure'); } };
} }));
vi.mock('../../src/database/prisma.service.js', () => ({ PrismaService: class {
  constructor() { fixture.prisma = this; }
  user = { create: async () => { if (fixture.fail === 'fixture') throw Error('fixture failure'); return { id: 'actor' }; } };
  async $disconnect() { fixture.events.push('prisma'); if (fixture.fail === 'close') throw Error('prisma close failure'); }
} }));
vi.mock('@nestjs/testing', () => ({ Test: { createTestingModule: () => {
  const builder = { overrideProvider: () => builder, useValue: () => builder, compile: async () => {
    if (fixture.fail === 'compile') throw Error('compile failure');
    return { close: async () => { fixture.events.push('module'); }, createNestApplication: () => {
      if (fixture.fail === 'application') throw Error('application failure');
      return { setGlobalPrefix: () => {}, enableCors: () => {}, use: () => {}, useGlobalFilters: () => {}, useGlobalPipes: () => {},
        init: async () => { if (fixture.fail === 'init') throw Error('init failure'); }, get: () => fixture.prisma,
        close: async () => { fixture.events.push('app'); if (fixture.fail === 'close') throw Error('app close failure'); } };
    } };
  } }; return builder;
} } }));
// Only resource boundaries are injected. The real harness owns initialization,
// error propagation, cleanup ordering and environment restoration under test.
import { createOrderHarness } from './support/order-harness.js';
import { PrismaService } from '../../src/database/prisma.service.js';

afterEach(() => { process.env.DATABASE_URL = fixture.source; fixture.events = []; fixture.fail = ''; });
for (const stage of ['compile', 'application', 'init', 'fixture']) {
  it(`cleans retained resources when ${stage} fails before returning a harness`, async () => {
    fixture.fail = stage; new PrismaService(); const source = process.env.DATABASE_URL;
    await expect(createOrderHarness()).rejects.toThrow(`${stage} failure`);
    expect(fixture.events).toEqual(stage === 'compile' ? ['prisma', 'database'] : stage === 'application' ? ['module', 'prisma', 'database'] : ['app', 'prisma', 'database']);
    expect(process.env.DATABASE_URL === source).toBe(true);
  });
}
it('attempts all normal cleanup operations and preserves every failure', async () => {
  new PrismaService(); const source = process.env.DATABASE_URL; const h = await createOrderHarness(); fixture.fail = 'close';
  await expect(h.close()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'app close failure' }), expect.objectContaining({ message: 'prisma close failure' }), expect.objectContaining({ message: 'database close failure' })] });
  expect(fixture.events).toEqual(['app', 'prisma', 'database']); expect(process.env.DATABASE_URL === source).toBe(true);
});
