import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { BadRequestException, ConflictException, Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { CaseTx } from '../after-sales/case.types.js';
import { PrismaService } from '../database/prisma.service.js';
import type { EvidenceCleanupJob } from '../generated/prisma/client.js';
import { EVIDENCE_STORAGE_PORT, type EvidenceStoragePort, type OwnedEvidenceObject } from './evidence-storage.port.js';

const objectsSchema = z.array(z.strictObject({ owner: z.string().uuid(), key: z.string().min(1), state: z.enum(['PLANNED', 'OWNED']) })).min(1).max(18);
@Injectable()
export class EvidenceCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly instance = randomUUID();
  private readonly host = hostname();
  private readonly ended = new Set<string>();
  private readonly cursors: Partial<Record<'OPEN' | 'READY', { createdAt: Date; id: string }>> = {};
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EVIDENCE_STORAGE_PORT) private readonly storage: EvidenceStoragePort,
  ) {}

  async begin(owner: string, objects: OwnedEvidenceObject[]): Promise<void> {
    const parsed = objectsSchema.safeParse(objects.map(object => ({ ...object, state: 'PLANNED' })));
    if (!parsed.success || objects.some(object => object.owner !== owner) || new Set(objects.map(object => object.key)).size !== objects.length || !this.storage.scope) throw new BadRequestException('Invalid bounded cleanup ownership');
    await this.prisma.evidenceCleanupJob.create({ data: { id: owner, creatorInstance: this.instance, creatorPid: process.pid, creatorHost: this.host, storageScope: this.storage.scope, objects: parsed.data } });
  }

  async markOwned(owner: string, key: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const job = await this.lockOpen(tx, owner);
      const objects = objectsSchema.parse(job.objects);
      const object = objects.find(value => value.key === key);
      if (!object) throw new ConflictException('Unregistered evidence object');
      object.state = 'OWNED';
      await tx.evidenceCleanupJob.update({ where: { id: owner }, data: { objects } });
    });
  }

  async readyInTransaction(tx: CaseTx, owner: string): Promise<void> {
    await this.lockOpen(tx, owner);
    await tx.evidenceCleanupJob.update({ where: { id: owner }, data: { state: 'READY' } });
  }

  private async lockOpen(tx: CaseTx, owner: string) {
    await tx.$queryRaw`SELECT id FROM "EvidenceCleanupJob" WHERE id = ${owner}::uuid FOR UPDATE`;
    const job = await tx.evidenceCleanupJob.findUnique({ where: { id: owner } });
    if (!job || job.state !== 'OPEN' || job.creatorInstance !== this.instance || job.storageScope !== this.storage.scope) throw new ConflictException('Evidence upload was fenced from committing');
    return job;
  }

  // This is an independent recovery result; it must never replace the command's
  // committed result or original error. Failed transitions leave durable OPEN work.
  async finish(owner: string): Promise<void> {
    this.ended.add(owner);
    try {
      await this.prisma.evidenceCleanupJob.updateMany({ where: { id: owner, creatorInstance: this.instance, state: 'OPEN' }, data: { state: 'READY' } });
      await this.clean(owner);
    } catch { /* Retry from durable job on the next bounded drain. */ }
  }

  async drain(limit = 10): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Invalid cleanup batch limit');
    if (!this.storage.scope) return;
    // Separate bounded sets prevent unprovable OPEN jobs from starving READY work.
    const open = await this.nextBatch('OPEN', limit);
    for (const job of open) {
      if (!this.creatorEnded(job)) continue;
      try { await this.prisma.evidenceCleanupJob.updateMany({ where: { id: job.id, state: 'OPEN' }, data: { state: 'READY' } }); } catch { /* Keep OPEN for retry. */ }
    }
    const ready = await this.nextBatch('READY', limit);
    for (const job of ready) {
      try { await this.clean(job.id); } catch { /* Keep this job and continue other owners. */ }
    }
  }

  private async nextBatch(state: 'OPEN' | 'READY', limit: number): Promise<EvidenceCleanupJob[]> {
    const scope = { creatorHost: this.host, storageScope: this.storage.scope!, state };
    const cursor = this.cursors[state];
    const query = (after?: typeof cursor) => this.prisma.evidenceCleanupJob.findMany({
      where: { ...scope, ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}) },
      take: limit, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let batch = await query(cursor);
    if (!batch.length && cursor) batch = await query();
    const last = batch.at(-1);
    if (last) this.cursors[state] = { createdAt: last.createdAt, id: last.id };
    else delete this.cursors[state];
    return batch;
  }

  private creatorEnded(job: EvidenceCleanupJob): boolean {
    if (job.creatorInstance === this.instance) return this.ended.has(job.id);
    // A live/reused PID or inaccessible/foreign process is NOT proof of death.
    try { process.kill(job.creatorPid, 0); return false; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'; }
  }

  private async clean(owner: string): Promise<void> {
    const job = await this.prisma.evidenceCleanupJob.findUnique({ where: { id: owner } });
    if (!job) { this.ended.delete(owner); return; }
    if (job.state !== 'READY' || job.creatorHost !== this.host || job.storageScope !== this.storage.scope) return;
    const objects = objectsSchema.parse(job.objects);
    if (objects.some(object => object.owner !== owner)) throw new BadRequestException('Cleanup owner differs');
    const keys = objects.map(object => object.key);
    // Query uncertainty keeps the whole batch. Never delete before a fresh check.
    const rows = await this.prisma.caseEvidence.findMany({ where: { OR: [{ originalKey: { in: keys } }, { displayKey: { in: keys } }] }, select: { originalKey: true, displayKey: true } });
    const referenced = new Set(rows.flatMap(row => [row.originalKey, row.displayKey]));
    const remaining: typeof objects = [];
    for (const object of objects) {
      if (referenced.has(object.key)) continue;
      try {
        if (object.state === 'OWNED') await this.storage.deleteOwned(object);
        else if (await this.storage.exists(object)) remaining.push(object); // EEXIST or unconfirmed creation: retain for verification.
      } catch { remaining.push(object); }
    }
    if (remaining.length) await this.prisma.evidenceCleanupJob.updateMany({ where: { id: owner, state: 'READY' }, data: { objects: remaining } });
    else {
      await this.prisma.evidenceCleanupJob.deleteMany({ where: { id: owner, state: 'READY' } });
      this.ended.delete(owner);
    }
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.storage.scope || this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref();
  }
  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain().catch(() => { /* Durable jobs survive database outages. */ }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
