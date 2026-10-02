import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { CreateItemSchema } from '@barter/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { configureApp } from '../src/main.js';
import { ItemImagesController } from '../src/storage/item-images.controller.js';
import { LocalImageStorageAdapter } from '../src/storage/local-image-storage.adapter.js';

const jwtSecret = 'task-5-e2e-jwt-secret-with-sufficient-entropy';
const openid = 'task-5-upload-e2e-customer';

function signCustomerToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, roles: ['CUSTOMER'], type: 'CUSTOMER', iat: now, exp: now + 900 }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`;
}

describe('item image uploads', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let customerId: string;
  let operatorId: string;
  let customerToken: string;
  let operatorToken: string;
  let storageDirectory: string;
  const originalEnv = {
    jwtSecret: process.env.JWT_SECRET,
    imageDirectory: process.env.LOCAL_IMAGE_STORAGE_DIR,
    publicBaseUrl: process.env.IMAGE_PUBLIC_BASE_URL,
  };

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), 'barter-item-images-'));
    process.env.JWT_SECRET = jwtSecret;
    process.env.LOCAL_IMAGE_STORAGE_DIR = storageDirectory;
    process.env.IMAGE_PUBLIC_BASE_URL = 'http://localhost:3000/api/uploads/item-images/files';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.user.deleteMany({ where: { wechatOpenid: openid } });
    await prisma.user.deleteMany({
      where: { adminCredential: { email: 'task-5-upload-operator@example.test' } },
    });
    const customer = await prisma.user.create({
      data: { wechatOpenid: openid, roles: { create: { role: 'CUSTOMER' } } },
    });
    customerId = customer.id;
    customerToken = signCustomerToken(customer.id);
    const operator = await prisma.user.create({
      data: {
        roles: { create: { role: 'OPERATIONS' } },
        adminCredential: {
          create: {
            email: 'task-5-upload-operator@example.test',
            passwordHash: 'not-used-by-this-test',
          },
        },
      },
    });
    operatorId = operator.id;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: operatorId,
        roles: ['OPERATIONS'],
        type: 'OPERATOR',
        iat: now,
        exp: now + 900,
      }),
    ).toString('base64url');
    const unsigned = `${header}.${payload}`;
    operatorToken = `${unsigned}.${createHmac('sha256', jwtSecret)
      .update(unsigned)
      .digest('base64url')}`;
  });

  afterAll(async () => {
    if (prisma && customerId) {
      await prisma.auditLog.deleteMany({ where: { actorId: customerId } });
      await prisma.user.deleteMany({
        where: { id: { in: [customerId, operatorId] } },
      });
    }
    if (app) await app.close();
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
    if (originalEnv.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalEnv.jwtSecret;
    if (originalEnv.imageDirectory === undefined) delete process.env.LOCAL_IMAGE_STORAGE_DIR;
    else process.env.LOCAL_IMAGE_STORAGE_DIR = originalEnv.imageDirectory;
    if (originalEnv.publicBaseUrl === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
    else process.env.IMAGE_PUBLIC_BASE_URL = originalEnv.publicBaseUrl;
  });

  it('rejects a non-image upload', async () => {
    await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .set('Authorization', `Bearer ${customerToken}`)
      .attach('file', Buffer.from('not an image'), 'note.txt')
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
  });

  it('rejects a declared image whose bytes have a different signature', async () => {
    await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .set('Authorization', `Bearer ${customerToken}`)
      .attach('file', Buffer.from('plain text'), { filename: 'fake.png', contentType: 'image/png' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
  });

  it('rejects an image larger than 8 MB', async () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
    oversized.set([0xff, 0xd8, 0xff], 0);
    await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .set('Authorization', `Bearer ${customerToken}`)
      .attach('file', oversized, { filename: 'huge.jpg', contentType: 'image/jpeg' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
  });

  it('stores a validated PNG under a generated UUID name and serves it', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);
    const upload = await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .set('Authorization', `Bearer ${customerToken}`)
      .attach('file', png, { filename: '../../escape.png', contentType: 'image/png' })
      .expect(201);

    expect(upload.body.url).toMatch(
      /^http:\/\/localhost:3000\/api\/uploads\/item-images\/files\/[0-9a-f-]{36}\.png$/,
    );
    expect(
      CreateItemSchema.safeParse({
        title: '合法上传图片测试条目',
        description: '上传端点返回的地址必须能够通过共享条目协议校验。',
        referenceValueFen: 1_000,
        condition: 'GOOD',
        imageUrls: [upload.body.url, upload.body.url, upload.body.url],
        wantedText: '',
      }).success,
    ).toBe(true);
    const filename = basename(new URL(upload.body.url as string).pathname);
    expect(filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    await expect(readFile(join(storageDirectory, filename))).resolves.toEqual(png);

    await request(app.getHttpServer())
      .get(`/api/uploads/item-images/files/${filename}`)
      .expect(200)
      .expect('Content-Type', /image\/png/)
      .expect(({ body }) => expect(body).toEqual(png));
  });

  it.each([
    {
      label: 'JPEG',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      contentType: 'image/jpeg',
      extension: 'jpg',
    },
    {
      label: 'WebP',
      bytes: Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary'),
      contentType: 'image/webp',
      extension: 'webp',
    },
  ])('accepts a valid $label signature', async ({ bytes, contentType, extension }) => {
    await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .set('Authorization', `Bearer ${customerToken}`)
      .attach('file', bytes, { filename: `image.${extension}`, contentType })
      .expect(201)
      .expect(({ body }) => {
        expect(body.url).toMatch(new RegExp(`^[^?]+\\.${extension}$`));
      });
  });

  it('requires customer authentication', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .attach('file', png, { filename: 'image.png', contentType: 'image/png' })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('AUTH_REQUIRED'));
  });

  it('rejects an operator token on the customer upload route', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await request(app.getHttpServer())
      .post('/api/uploads/item-images')
      .set('Authorization', `Bearer ${operatorToken}`)
      .attach('file', png, { filename: 'image.png', contentType: 'image/png' })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
  });

  it.each(['development', 'test'])('allows local storage in %s', (nodeEnv) => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    try {
      expect(() => new LocalImageStorageAdapter()).not.toThrow();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it.each([undefined, 'staging', 'qa', 'production'])(
    'rejects local storage outside development/test when NODE_ENV is %s',
    (nodeEnv) => {
      const originalNodeEnv = process.env.NODE_ENV;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      try {
        expect(() => new LocalImageStorageAdapter()).toThrow(/development|test/i);
      } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    },
  );

  it('does not serve local files outside development or test', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    const read = vi.fn().mockResolvedValue({
      bytes: Buffer.from('should-not-be-read'),
      contentType: 'image/png',
    });
    const controller = new ItemImagesController(
      { save: vi.fn() } as never,
      { read } as never,
    );
    const response = { setHeader: vi.fn() };
    try {
      await expect(
        controller.serve(
          '00000000-0000-4000-8000-000000000001.png',
          response as never,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(read).not.toHaveBeenCalled();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
