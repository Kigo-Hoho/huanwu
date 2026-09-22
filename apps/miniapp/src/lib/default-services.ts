import Taro from '@tarojs/taro';

import {
  createIdentityCodeProvider,
  type IdentityCodeProvider,
} from '../features/auth/identity-code.provider';
import { Session } from '../features/auth/session';
import { ImageUploadClient } from '../features/images/image-upload.client';
import { AuthenticatedApiClient } from './api-client';

const baseUrl = typeof __API_BASE_URL__ === 'string' ? __API_BASE_URL__ : 'http://localhost:3000';
const session = new Session();

export const defaultIdentityProvider: IdentityCodeProvider = createIdentityCodeProvider({
  provider: typeof __IDENTITY_PROVIDER__ === 'string' ? __IDENTITY_PROVIDER__ : 'taro',
  target: typeof __TARO_TARGET__ === 'string' ? __TARO_TARGET__ : 'weapp',
  buildEnvironment:
    typeof __BUILD_ENVIRONMENT__ === 'string' ? __BUILD_ENVIRONMENT__ : 'development',
});
export const defaultApiClient = new AuthenticatedApiClient(baseUrl, session);
export const defaultImageUploadClient = new ImageUploadClient(baseUrl, session);

export async function chooseItemImages(): Promise<string[]> {
  const result = await Taro.chooseMedia({ count: 9, mediaType: ['image'] });
  return result.tempFiles.map(({ tempFilePath }) => tempFilePath);
}

export function createSubmitCommandKey(): string {
  const random = Math.random().toString(36).slice(2);
  return `submit-${Date.now().toString(36)}-${random}`;
}
