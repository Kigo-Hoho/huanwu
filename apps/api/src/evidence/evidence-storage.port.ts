export interface EvidenceUpload { bytes: Buffer; contentType: string }
export const EVIDENCE_STORAGE_PORT = Symbol('EvidenceStoragePort');
export interface OwnedEvidenceObject { key: string; owner: string }
export interface EvidenceStoragePort {
  readonly scope: string | null;
  allocate(owner: string): OwnedEvidenceObject;
  // onCreated durably acknowledges exclusive creation BEFORE any private bytes.
  save(object: string | OwnedEvidenceObject, bytes: Buffer, onCreated?: () => Promise<void>): Promise<OwnedEvidenceObject>;
  exists(object: OwnedEvidenceObject): Promise<boolean>;
  read(key: string): Promise<Buffer>;
  deleteOwned(object: OwnedEvidenceObject): Promise<void>;
}
