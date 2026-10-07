import { createHmac } from 'node:crypto';

import type { Role } from '@barter/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { WechatIdentityProvider } from '../src/auth/wechat-identity.provider.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { configureApp } from '../src/main.js';

const jwtSecret = 'task-4-e2e-jwt-secret-with-sufficient-entropy';
const customerOpenid = 'task-4-e2e-customer';
const mixedOperatorOpenid = 'task-4-mixed-operator';

function signToken(payload: {
  sub: string;
  roles: Role[];
  type: 'CUSTOMER' | 'OPERATOR';
  iat: number;
  exp: number;
}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const unsignedToken = `${header}.${encodedPayload}`;
  const signature = createHmac('sha256', jwtSecret)
    .update(unsignedToken)
    .digest('base64url');

  return `${unsignedToken}.${signature}`;
}

describe('authentication and role authorization', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let customerToken: string;
  let reviewerToken: string;
  let customerId: string;
  let reviewerId: string;
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    if (!process.env.ADMIN_SEED_PASSWORD) {
      throw new Error(
        'ADMIN_SEED_PASSWORD must match the password used by the explicit test seed',
      );
    }
    process.env.JWT_SECRET = jwtSecret;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WechatIdentityProvider)
      .useValue({
        exchangeCode: async (code: string) => {
          if (code === 'valid-customer-code') {
            return { openid: customerOpenid };
          }
          if (code === 'mixed-operator-code') {
            return { openid: mixedOperatorOpenid };
          }
          throw new Error('unexpected test identity code');
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const customerResponse = await request(app.getHttpServer())
      .post('/api/auth/wechat')
      .send({ code: 'valid-customer-code' })
      .expect(201);
    customerToken = customerResponse.body.accessToken as string;
    customerId = customerResponse.body.user.id as string;

    const reviewerResponse = await request(app.getHttpServer())
      .post('/api/auth/admin/password')
      .send({
        email: 'reviewer@barter.local',
        password: process.env.ADMIN_SEED_PASSWORD,
        roles: ['SUPER_ADMIN'],
      })
      .expect(201);
    reviewerToken = reviewerResponse.body.accessToken as string;
    reviewerId = reviewerResponse.body.user.id as string;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  it('creates a customer from an injected WeChat identity and returns its session', async () => {
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ id: customerId, roles: ['CUSTOMER'] });
      });

    const persistedRoles = await prisma.userRole.findMany({
      where: { userId: customerId },
      select: { role: true },
    });
    expect(persistedRoles).toEqual([{ role: 'CUSTOMER' }]);
  });

  it('rejects a request without a bearer token', async () => {
    await request(app.getHttpServer())
      .get('/api/me')
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('AUTH_REQUIRED'));
  });

  it('rejects an invalid token', async () => {
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('AUTH_REQUIRED'));
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = signToken({
      sub: customerId,
      roles: ['CUSTOMER'],
      type: 'CUSTOMER',
      iat: now - 120,
      exp: now - 60,
    });

    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('AUTH_REQUIRED'));
  });

  it('rejects an operator route token without an operator role', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/session')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
  });

  it('allows the seeded reviewer and ignores client-supplied roles', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/session')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.roles).toEqual(['REVIEWER']);
        expect(body.roles).not.toContain('CUSTOMER');
        expect(body.roles).not.toContain('SUPER_ADMIN');
      });
  });

  it('revokes a previously issued operator token immediately when its role is removed', async () => {
    await prisma.userRole.delete({
      where: { userId_role: { userId: reviewerId, role: 'REVIEWER' } },
    });
    try {
      await request(app.getHttpServer())
        .get('/api/admin/session')
        .set('Authorization', `Bearer ${reviewerToken}`)
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    } finally {
      await prisma.userRole.create({
        data: { userId: reviewerId, role: 'REVIEWER' },
      });
    }
  });

  it('invalidates a previously issued token immediately when the operator is disabled', async () => {
    await prisma.user.update({
      where: { id: reviewerId },
      data: { disabledAt: new Date() },
    });
    try {
      await request(app.getHttpServer())
        .get('/api/admin/session')
        .set('Authorization', `Bearer ${reviewerToken}`)
        .expect(401)
        .expect(({ body }) => expect(body.code).toBe('AUTH_REQUIRED'));
    } finally {
      await prisma.user.update({
        where: { id: reviewerId },
        data: { disabledAt: null },
      });
    }
  });

  it('rejects admin login for an identity that also has a WeChat openid', async () => {
    await prisma.user.update({
      where: { id: reviewerId },
      data: { wechatOpenid: mixedOperatorOpenid },
    });
    try {
      await request(app.getHttpServer())
        .post('/api/auth/admin/password')
        .send({
          email: 'reviewer@barter.local',
          password: process.env.ADMIN_SEED_PASSWORD,
        })
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    } finally {
      await prisma.user.update({
        where: { id: reviewerId },
        data: { wechatOpenid: null },
      });
    }
  });

  it('does not turn an operator identity into a customer through WeChat login', async () => {
    await prisma.user.update({
      where: { id: reviewerId },
      data: { wechatOpenid: mixedOperatorOpenid },
    });
    try {
      await request(app.getHttpServer())
        .post('/api/auth/wechat')
        .send({ code: 'mixed-operator-code' })
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));

      await expect(
        prisma.userRole.findUnique({
          where: { userId_role: { userId: reviewerId, role: 'CUSTOMER' } },
        }),
      ).resolves.toBeNull();
    } finally {
      await prisma.user.update({
        where: { id: reviewerId },
        data: { wechatOpenid: null },
      });
    }
  });

  it('rejects an incorrect operator password', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/admin/password')
      .send({ email: 'reviewer@barter.local', password: 'incorrect-password' })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('AUTH_REQUIRED'));
  });
});
