import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalPrivateEvidenceAdapter, UnavailablePrivateEvidenceAdapter } from './local-private-evidence.adapter.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), open: vi.fn(actual.open) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
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

it('retains ownership of a file created and partially written before an I/O failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barter-private-adapter-partial-'));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_PRIVATE_EVIDENCE_DIR', directory);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
      await write(Buffer.from('partial'));
      throw Object.assign(new Error('disk failed after partial write'), { code: 'EIO' });
    });
    return handle;
  });
  try {
    await expect(new LocalPrivateEvidenceAdapter().save(randomUUID(), Buffer.from('complete evidence'))).rejects.toThrow('disk failed after partial write');
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true }); }
});

it('never removes the existing object when exclusive creation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barter-private-adapter-collision-'));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_PRIVATE_EVIDENCE_DIR', directory);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    await actual.writeFile(path, Buffer.from('not this upload'));
    return actual.open(path, flags, mode);
  });
  try {
    await expect(new LocalPrivateEvidenceAdapter().save(randomUUID(), Buffer.from('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, files[0]), 'utf8')).toBe('not this upload');
  } finally { await rm(directory, { recursive: true }); }
});
