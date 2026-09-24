import type { SynchronousStorage } from './session';

export const defaultSessionStorage: SynchronousStorage = {
  getStorageSync(key) {
    const value = window.localStorage.getItem(key);
    if (value === null) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      window.localStorage.removeItem(key);
      return undefined;
    }
  },
  setStorageSync(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeStorageSync(key) {
    window.localStorage.removeItem(key);
  },
};
