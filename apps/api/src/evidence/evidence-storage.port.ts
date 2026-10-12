export interface EvidenceUpload { bytes: Buffer; contentType: string }
export const EVIDENCE_STORAGE_PORT = Symbol('EvidenceStoragePort');
export interface OwnedEvidenceObject { key: string; owner: string }
export interface EvidenceStoragePort {
  save(owner: string, bytes: Buffer): Promise<OwnedEvidenceObject>;
  read(key: string): Promise<Buffer>;
  deleteOwned(object: OwnedEvidenceObject): Promise<void>;
}
