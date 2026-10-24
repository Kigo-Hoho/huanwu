import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { EvidenceStoragePort, OwnedEvidenceObject } from './evidence-storage.port.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const keyPattern = new RegExp(`^(${uuid})-(${uuid})$`);
export class LocalPrivateEvidenceAdapter implements EvidenceStoragePort {
  readonly directory: string;
  readonly scope: string;
  constructor() {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new ServiceUnavailableException('Private evidence storage is not configured');
    this.directory = resolve(process.env.LOCAL_PRIVATE_EVIDENCE_DIR ?? '.local/private-evidence');
    const publicDirectory = resolve(process.env.LOCAL_IMAGE_STORAGE_DIR ?? '.local/item-images');
    const fromPublic = relative(publicDirectory, this.directory);
    const fromPrivate = relative(this.directory, publicDirectory);
    const inside = (path: string) => !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
    if (inside(fromPublic) || inside(fromPrivate)) throw new Error('Private evidence directory must be separate from public images');
    this.scope = createHash('sha256').update(process.platform === 'win32' ? this.directory.toLowerCase() : this.directory).digest('hex');
  }
  allocate(owner: string): OwnedEvidenceObject {
    const object = { key: `${owner}-${randomUUID()}`, owner };
    this.assertOwned(object);
    return object;
  }
  async save(input: string | OwnedEvidenceObject, bytes: Buffer, onCreated?: () => Promise<void>): Promise<OwnedEvidenceObject> {
    const object = typeof input === 'string' ? this.allocate(input) : input;
    this.assertOwned(object);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // open failure (especially EEXIST) has no cleanup authority over that path.
    const handle = await open(resolve(this.directory, object.key), 'wx', 0o600);
    try {
      await onCreated?.();
      await handle.writeFile(bytes);
      await handle.close();
      return object;
    } catch (error) {
      try { await handle.close(); } catch { /* Preserve the original I/O error. */ }
      try { await this.deleteOwned(object); } catch { /* Durable job retains the descriptor. */ }
      throw error;
    }
  }
  async exists(object: OwnedEvidenceObject): Promise<boolean> {
    this.assertOwned(object);
    try { await stat(resolve(this.directory, object.key)); return true; }
    catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
  }
  async read(key: string): Promise<Buffer> {
    if (!keyPattern.test(key)) throw new NotFoundException('Evidence was not found');
    try { return await readFile(resolve(this.directory, key)); }
    catch (error) { if (hasCode(error, 'ENOENT')) throw new NotFoundException('Evidence was not found'); throw error; }
  }
  async deleteOwned(object: OwnedEvidenceObject): Promise<void> {
    this.assertOwned(object);
    try { await unlink(resolve(this.directory, object.key)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
  private assertOwned(object: OwnedEvidenceObject) {
    if (keyPattern.exec(object.key)?.[1] !== object.owner) throw new BadRequestException('Storage ownership does not match');
  }
}
function hasCode(error: unknown, code: string) { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
// Production deliberately has no development directory fallback.
export class UnavailablePrivateEvidenceAdapter implements EvidenceStoragePort {
  readonly scope = null;
  allocate(): OwnedEvidenceObject { throw new ServiceUnavailableException('Private evidence storage is not configured'); }
  save(): Promise<OwnedEvidenceObject> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
  exists(): Promise<boolean> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
  read(): Promise<Buffer> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
  deleteOwned(): Promise<void> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
}
