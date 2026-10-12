import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalPrivateEvidenceAdapter, UnavailablePrivateEvidenceAdapter } from './local-private-evidence.adapter.js';

afterEach(() => vi.unstubAllEnvs());
it('uses opaque owned keys, refuses traversal and cannot delete another upload object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barter-private-adapter-test-'));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_PRIVATE_EVIDENCE_DIR', directory);
  try {
    const storage = new LocalPrivateEvidenceAdapter();
    const bytes = Buffer.from('private original bytes');
    const object = await storage.save(randomUUID(), bytes);
    expect(await storage.read(object.key)).toEqual(bytes);
    await expect(storage.deleteOwned({ ...object, owner: randomUUID() })).rejects.toMatchObject({ status: 400 });
    expect(await storage.read(object.key)).toEqual(bytes);
    await expect(storage.read('../outside')).rejects.toMatchObject({ status: 404 });
    await expect(storage.save('../outside', bytes)).rejects.toMatchObject({ status: 400 });
    await storage.deleteOwned(object);
    await expect(storage.read(object.key)).rejects.toMatchObject({ status: 404 });
  } finally { await rm(directory, { recursive: true }); }
});
it('refuses overlapping public directories and never enables local production storage', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOCAL_IMAGE_STORAGE_DIR', join(tmpdir(), 'public-evidence-boundary'));
  for (const directory of [join(tmpdir(), 'public-evidence-boundary'), join(tmpdir(), 'public-evidence-boundary', 'private'), join(tmpdir(), 'public-evidence-boundary', '..private'), tmpdir()]) {
    vi.stubEnv('LOCAL_PRIVATE_EVIDENCE_DIR', directory);
    expect(() => new LocalPrivateEvidenceAdapter()).toThrow('must be separate');
  }
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => new LocalPrivateEvidenceAdapter()).toThrow('not configured');
  const unavailable = new UnavailablePrivateEvidenceAdapter();
  await expect(unavailable.save()).rejects.toMatchObject({ status: 503 });
  await expect(unavailable.read()).rejects.toMatchObject({ status: 503 });
  await expect(unavailable.deleteOwned()).rejects.toMatchObject({ status: 503 });
});
