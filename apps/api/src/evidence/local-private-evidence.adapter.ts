import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { EvidenceStoragePort, OwnedEvidenceObject } from './evidence-storage.port.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const keyPattern = new RegExp(`^(${uuid})-(${uuid})$`);
export class LocalPrivateEvidenceAdapter implements EvidenceStoragePort {
  readonly directory: string;
  constructor() {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new ServiceUnavailableException('Private evidence storage is not configured');
    this.directory = resolve(process.env.LOCAL_PRIVATE_EVIDENCE_DIR ?? '.local/private-evidence');
    const publicDirectory = resolve(process.env.LOCAL_IMAGE_STORAGE_DIR ?? '.local/item-images');
    const fromPublic = relative(publicDirectory, this.directory);
    const fromPrivate = relative(this.directory, publicDirectory);
    const inside = (path: string) => !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
    if (inside(fromPublic) || inside(fromPrivate)) throw new Error('Private evidence directory must be separate from public images');
  }
  async save(owner: string, bytes: Buffer): Promise<OwnedEvidenceObject> {
    const key = `${owner}-${randomUUID()}`;
    if (!keyPattern.test(key)) throw new BadRequestException('Invalid storage ownership');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(resolve(this.directory, key), bytes, { flag: 'wx', mode: 0o600 });
    return { key, owner };
  }
  async read(key: string): Promise<Buffer> {
    if (!keyPattern.test(key)) throw new NotFoundException('Evidence was not found');
    try { return await readFile(resolve(this.directory, key)); }
    catch (error) { if (hasCode(error, 'ENOENT')) throw new NotFoundException('Evidence was not found'); throw error; }
  }
  async deleteOwned(object: OwnedEvidenceObject): Promise<void> {
    if (keyPattern.exec(object.key)?.[1] !== object.owner) throw new BadRequestException('Storage ownership does not match');
    try { await unlink(resolve(this.directory, object.key)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}
function hasCode(error: unknown, code: string) { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
// Production deliberately has no development directory fallback.
export class UnavailablePrivateEvidenceAdapter implements EvidenceStoragePort {
  save(): Promise<OwnedEvidenceObject> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
  read(): Promise<Buffer> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
  deleteOwned(): Promise<void> { return Promise.reject(new ServiceUnavailableException('Private evidence storage is not configured')); }
}
