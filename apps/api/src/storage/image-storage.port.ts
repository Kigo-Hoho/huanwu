export const IMAGE_STORAGE_PORT = Symbol('IMAGE_STORAGE_PORT');

export interface SaveImageInput {
  ownerId: string;
  contentType: string;
  bytes: Buffer;
}

export interface ImageStoragePort {
  save(input: SaveImageInput): Promise<{ url: string }>;
}
