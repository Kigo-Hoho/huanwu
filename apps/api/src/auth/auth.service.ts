import { createHmac, timingSafeEqual } from 'node:crypto';

import { RoleValues, type Role } from '@barter/contracts';
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';

import { PrismaService } from '../database/prisma.service.js';
import {
  CUSTOMER_IDENTITY_PROVIDER,
  type CustomerIdentityProvider,
} from './wechat-identity.provider.js';

const operatorRoles: readonly Role[] = [
  'OPERATIONS',
  'REVIEWER',
  'SUPER_ADMIN',
];
const accessTokenTtlSeconds = 15 * 60;

export interface AuthenticatedUser {
  id: string;
  roles: Role[];
}

export interface AuthenticatedPrincipal extends AuthenticatedUser {
  type: 'CUSTOMER' | 'OPERATOR';
}

interface AccessTokenClaims {
  sub: string;
  roles: Role[];
  type: AuthenticatedPrincipal['type'];
  iat: number;
  exp: number;
}

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && RoleValues.includes(value as Role);
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(CUSTOMER_IDENTITY_PROVIDER)
    private readonly customerIdentityProvider: CustomerIdentityProvider,
  ) {}

  async authenticateWechat(code: string): Promise<AuthSession> {
    const { openid } = await this.customerIdentityProvider.exchangeCode(code);
    const user = await this.prisma.$transaction(async (tx) => {
      const identity = await tx.user.upsert({
        where: { wechatOpenid: openid },
        update: {},
        create: { wechatOpenid: openid },
        include: { adminCredential: true, roles: true },
      });

      if (
        identity.adminCredential !== null ||
        identity.roles.some(({ role }) => role !== 'CUSTOMER')
      ) {
        throw new ForbiddenException(
          'Operator accounts cannot authenticate as customers',
        );
      }
      if (identity.disabledAt !== null) {
        throw new UnauthorizedException('Account is disabled');
      }

      await tx.userRole.upsert({
        where: { userId_role: { userId: identity.id, role: 'CUSTOMER' } },
        update: {},
        create: { userId: identity.id, role: 'CUSTOMER' },
      });
      return { id: identity.id, roles: ['CUSTOMER'] as Role[] };
    });

    return this.createSession(user, 'CUSTOMER');
  }

  async authenticateAdmin(email: string, password: string): Promise<AuthSession> {
    const credential = await this.prisma.adminCredential.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { user: { include: { roles: true } } },
    });
    const passwordMatches = credential
      ? await argon2.verify(credential.passwordHash, password)
      : false;
    if (!credential || !passwordMatches || credential.user.disabledAt !== null) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const storedRoles = credential.user.roles.map(({ role }) => role as Role);
    if (
      credential.user.wechatOpenid !== null ||
      storedRoles.includes('CUSTOMER')
    ) {
      throw new ForbiddenException(
        'Operator accounts cannot also hold a customer identity',
      );
    }
    const roles = storedRoles.filter((role) => operatorRoles.includes(role));
    if (roles.length === 0) {
      throw new ForbiddenException('Operator permission is required');
    }

    return this.createSession({ id: credential.user.id, roles }, 'OPERATOR');
  }

  verifyAccessToken(token: string): AuthenticatedPrincipal {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid access token');
    }

    const [encodedHeader, encodedPayload, providedSignature] = parts;
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = this.signature(unsignedToken);
    const provided = Buffer.from(providedSignature, 'base64url');
    const expected = Buffer.from(expectedSignature, 'base64url');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (
      typeof header !== 'object' ||
      header === null ||
      !('alg' in header) ||
      header.alg !== 'HS256' ||
      !this.isAccessTokenClaims(payload)
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now || payload.iat > now + 60) {
      throw new UnauthorizedException('Access token has expired');
    }

    return { id: payload.sub, roles: payload.roles, type: payload.type };
  }

  async rehydrateAuthenticatedUser(
    principal: AuthenticatedPrincipal,
  ): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { adminCredential: true, roles: true },
    });
    if (!user || user.disabledAt !== null) {
      throw new UnauthorizedException('Account is unavailable');
    }

    const storedRoles = user.roles.map(({ role }) => role as Role);
    if (storedRoles.includes('CUSTOMER') && storedRoles.some(role => operatorRoles.includes(role))) {
      throw new ForbiddenException('Customer and operator roles cannot share a session');
    }
    if (principal.type === 'CUSTOMER') {
      if (
        user.wechatOpenid === null ||
        user.adminCredential !== null ||
        !storedRoles.includes('CUSTOMER') ||
        storedRoles.some((role) => operatorRoles.includes(role))
      ) {
        throw new UnauthorizedException('Customer identity is unavailable');
      }
      return { id: user.id, roles: ['CUSTOMER'] };
    }

    if (
      user.wechatOpenid !== null ||
      user.adminCredential === null ||
      storedRoles.includes('CUSTOMER')
    ) {
      throw new UnauthorizedException('Operator identity is unavailable');
    }

    return {
      id: user.id,
      roles: storedRoles.filter((role) => operatorRoles.includes(role)),
    };
  }

  private createSession(
    user: AuthenticatedUser,
    type: AccessTokenClaims['type'],
  ): AuthSession {
    const iat = Math.floor(Date.now() / 1000);
    const claims: AccessTokenClaims = {
      sub: user.id,
      roles: user.roles,
      type,
      iat,
      exp: iat + accessTokenTtlSeconds,
    };
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode(claims);
    const unsignedToken = `${header}.${payload}`;

    return {
      accessToken: `${unsignedToken}.${this.signature(unsignedToken)}`,
      expiresIn: accessTokenTtlSeconds,
      user,
    };
  }

  private signature(unsignedToken: string): string {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('JWT_SECRET must contain at least 32 characters');
    }
    return createHmac('sha256', secret)
      .update(unsignedToken)
      .digest('base64url');
  }

  private isAccessTokenClaims(value: unknown): value is AccessTokenClaims {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const claims = value as Partial<AccessTokenClaims>;
    if (
      typeof claims.sub !== 'string' ||
      !Array.isArray(claims.roles) ||
      claims.roles.length === 0 ||
      !claims.roles.every(isRole) ||
      (claims.type !== 'CUSTOMER' && claims.type !== 'OPERATOR') ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number'
    ) {
      return false;
    }

    return claims.type === 'CUSTOMER'
      ? claims.roles.length === 1 && claims.roles[0] === 'CUSTOMER'
      : claims.roles.every((role) => operatorRoles.includes(role));
  }
}
