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
      !Number.isFinite(value.expiresAt) ||
      this.now() >= value.expiresAt
    ) {
      if (value !== undefined && value !== null && value !== '') this.clear();
      return null;
    }
    return value.accessToken;
  }

  setAccessToken(accessToken: string, expiresInSeconds: number): void {
    if (accessToken.length === 0) throw new Error('Access token cannot be empty.');
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error('Access token expiry must be positive.');
    }
    const session: StoredSession = {
      accessToken,
      expiresAt: this.now() + expiresInSeconds * 1_000,
    };
    this.storage.setStorageSync(accessTokenKey, session);
  }

  clear(): void {
    this.storage.removeStorageSync(accessTokenKey);
  }
}
