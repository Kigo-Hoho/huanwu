import Taro from '@tarojs/taro';

const accessTokenKey = 'barter.customer.accessToken';

export interface SynchronousStorage {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: string): void;
  removeStorageSync(key: string): void;
}

export class Session {
  constructor(private readonly storage: SynchronousStorage = Taro) {}

  getAccessToken(): string | null {
    const value = this.storage.getStorageSync(accessTokenKey);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  setAccessToken(accessToken: string): void {
    if (accessToken.length === 0) throw new Error('Access token cannot be empty.');
    this.storage.setStorageSync(accessTokenKey, accessToken);
  }

  clear(): void {
    this.storage.removeStorageSync(accessTokenKey);
  }
}
