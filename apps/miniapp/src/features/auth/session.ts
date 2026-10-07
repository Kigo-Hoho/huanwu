import Taro from '@tarojs/taro';

const accessTokenKey = 'barter.customer.accessToken';

export interface SynchronousStorage {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
}

interface StoredSession {
  accessToken: string;
  expiresAt: number;
}

export class Session {
  private actorId: string | null = null;
  private identityToken: string | null = null;
  private observedToken: string | null = null;
  private credentialRevision = 0;
  private identityEpoch = 0;
  private readonly identityListeners = new Set<() => void>();
  getIdentity() { this.getAccessToken(); return { actorId: this.actorId, epoch: this.identityEpoch, credentialRevision: this.credentialRevision }; }
  onIdentityInvalidated(listener: () => void) { this.identityListeners.add(listener); return () => { this.identityListeners.delete(listener); }; }
  bindIdentity(actorId: string | null): void {
    const stored = this.storage.getStorageSync(accessTokenKey) as Partial<StoredSession> | undefined;
    this.identityToken = actorId !== null && typeof stored?.accessToken === 'string' ? stored.accessToken : null;
    if (actorId === this.actorId) return;
    const previous = this.actorId;
    this.actorId = actorId; this.identityEpoch += 1;
    if (previous !== null) for (const listener of this.identityListeners) listener();
  }
  constructor(
    private readonly storage: SynchronousStorage = Taro,
    private readonly now: () => number = Date.now,
  ) {}

  getAccessToken(): string | null {
    const value = this.storage.getStorageSync(accessTokenKey);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('accessToken' in value) ||
      !('expiresAt' in value) ||
      typeof value.accessToken !== 'string' ||
      value.accessToken.length === 0 ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt)
    ) {
      if (this.actorId !== null || this.observedToken !== null || value !== undefined && value !== null && value !== '') this.clear();
      return null;
    }
    if (this.observedToken !== value.accessToken) { this.observedToken = value.accessToken; this.credentialRevision += 1; }
    if (this.actorId !== null && this.identityToken !== value.accessToken) this.bindIdentity(null);
    // Expiry alone is not an identity change: same-actor recovery retains uncertain commands.
    return this.now() >= value.expiresAt ? null : value.accessToken;
  }

  setAccessToken(accessToken: string, expiresInSeconds: number, actorId: string | null = null): void {
    if (accessToken.length === 0) throw new Error('Access token cannot be empty.');
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error('Access token expiry must be positive.');
    }
    const session: StoredSession = {
      accessToken,
      expiresAt: this.now() + expiresInSeconds * 1_000,
    };
    this.storage.setStorageSync(accessTokenKey, session);
    this.observedToken = accessToken; this.credentialRevision += 1;
    this.bindIdentity(actorId);
  }

  clear(): void {
    this.storage.removeStorageSync(accessTokenKey);
    this.observedToken = null; this.credentialRevision += 1;
    this.bindIdentity(null);
  }
}
