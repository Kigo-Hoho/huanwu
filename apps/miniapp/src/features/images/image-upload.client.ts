import Taro from '@tarojs/taro';

import type { Session } from '../auth/session';

interface UploadOptions {
  url: string;
  filePath: string;
  name: string;
  header: Record<string, string>;
}

interface UploadResult {
  statusCode: number;
  data: string;
}

export type UploadFilePort = (options: UploadOptions) => Promise<UploadResult>;

export class ImageUploadClient {
  constructor(
    private readonly baseUrl: string,
    private readonly session: Session,
    private readonly uploadFile: UploadFilePort = (options) =>
      Taro.uploadFile(options as Taro.uploadFile.Option) as Promise<UploadResult>,
  ) {}

  async upload(localPath: string): Promise<string> {
    const token = this.session.getAccessToken();
    if (!token) throw new Error('Customer authentication is required before upload.');
    const result = await this.uploadFile({
      url: `${this.baseUrl.replace(/\/$/, '')}/api/uploads/item-images`,
      filePath: localPath,
      name: 'file',
      header: { Authorization: `Bearer ${token}` },
    });
    let body: unknown;
    try {
      body = JSON.parse(result.data);
    } catch {
      throw new Error('图片上传响应无效。');
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(
        typeof body === 'object' && body !== null && 'message' in body
          ? String(body.message)
          : '图片上传失败。',
      );
    }
    if (typeof body !== 'object' || body === null || !('url' in body)) {
      throw new Error('图片上传响应缺少地址。');
    }
    const url = String(body.url);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw new Error('图片上传响应必须包含有效的 HTTP 地址。');
    }
    return url;
  }
}
