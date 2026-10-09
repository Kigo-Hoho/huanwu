import { ActionGrantRequestSchema, OperatorDeviceCommandSchema, OperatorDeviceEnrollmentSchema, OperatorSessionRevokeSchema, OperatorLoginRequestSchema, OperatorSecurityListInputSchema, OperatorDeviceListResultSchema, OperatorSessionListResultSchema, type ActionGrantRequest, type OperatorSecurityListInput } from '@barter/contracts';
import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PrismaService } from '../database/prisma.service.js';
import { ActionGrantService } from './action-grant.service.js';
import { assertOperatorOrigin, OperatorSessionService } from './operator-session.service.js';
import { OperatorDeviceService } from './operator-device.service.js';
import type { z } from 'zod';
import { deviceView } from './operator-action.types.js';

export function requireOperatorSession(request: AuthenticatedRequest) {
  if (!request.operatorSession) throw new UnauthorizedException({ code: 'REAUTH_REQUIRED', message: 'Bound operator session required' });
  return request.operatorSession;
}
@Controller('admin/security')
export class OperatorSecurityController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService, @Inject(ActionGrantService) private readonly grants: ActionGrantService, @Inject(PrismaService) private readonly prisma: PrismaService, @Inject(OperatorDeviceService) private readonly deviceService: OperatorDeviceService) {}
  @Post('login')
  async login(@Body(new ZodValidationPipe(OperatorLoginRequestSchema)) body: { email: string; password: string }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    assertOperatorOrigin(request);
    const { user } = await this.auth.authenticateAdmin(body.email, body.password);
    const session = await this.sessions.login(user, request, response);
    return { ...this.auth.createOperatorSession(user, session.id, session.capability === 'DESKTOP_PRIVILEGED' ? 1800 : 900), operatorSession: session };
  }
  @Post('devices')
  @Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async enroll(@Body(new ZodValidationPipe(OperatorDeviceEnrollmentSchema)) _body: object, @Req() request: AuthenticatedRequest) {
    assertOperatorOrigin(request);
    const context = requireOperatorSession(request);
    const device = await this.prisma.operatorDevice.findUniqueOrThrow({ where: { id: context.deviceId } });
    return deviceView(device);
  }
  @Get('devices')
  @Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async devices(@Query(new ZodValidationPipe(OperatorSecurityListInputSchema)) query: OperatorSecurityListInput, @Req() request: AuthenticatedRequest) {
    const context = requireOperatorSession(request);
    const rows = await this.prisma.operatorDevice.findMany({
      where: { actorId: context.actor.id, ...cursorBoundary(query.cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return OperatorDeviceListResultSchema.parse({ items: page.map(deviceView), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]) : null });
  }
  @Get('sessions')
  @Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listSessions(@Query(new ZodValidationPipe(OperatorSecurityListInputSchema)) query: OperatorSecurityListInput, @Req() request: AuthenticatedRequest) {
    const context = requireOperatorSession(request);
    const rows = await this.prisma.operatorSession.findMany({
      where: { actorId: context.actor.id, revokedAt: null, ...cursorBoundary(query.cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return OperatorSessionListResultSchema.parse({
      items: page.map(({ id, version, deviceId, capability, expiresAt }) => ({ id, version, deviceId, capability, expiresAt: expiresAt.toISOString() })),
      nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]) : null,
    });
  }
  @Post('grants')
  @HttpCode(200)
  @Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async grant(@Body(new ZodValidationPipe(ActionGrantRequestSchema)) body: ActionGrantRequest, @Req() request: AuthenticatedRequest) {
    const context = requireOperatorSession(request);
    assertOperatorOrigin(request);
    return this.grants.issue(context, body);
  }
  @Post('devices/:id/approve')
  @HttpCode(200)
  @Roles('SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  approve(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OperatorDeviceCommandSchema)) body: z.infer<typeof OperatorDeviceCommandSchema>, @Headers('idempotency-key') key: string, @Req() request: AuthenticatedRequest) {
    return this.deviceCommand('APPROVE_DEVICE', id, body, key, request);
  }
  @Post('devices/:id/revoke')
  @HttpCode(200)
  @Roles('SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OperatorDeviceCommandSchema)) body: z.infer<typeof OperatorDeviceCommandSchema>, @Headers('idempotency-key') key: string, @Req() request: AuthenticatedRequest) {
    return this.deviceCommand('REVOKE_DEVICE', id, body, key, request);
  }
  private deviceCommand(action: 'APPROVE_DEVICE' | 'REVOKE_DEVICE', id: string, body: z.infer<typeof OperatorDeviceCommandSchema>, key: string, request: AuthenticatedRequest) {
    const context = requireOperatorSession(request);
    assertOperatorOrigin(request);
    if (body.operatorAction.sessionId !== context.sessionId) throw new ForbiddenException({ code: 'GRANT_INVALID', message: 'Session reference differs' });
    return this.deviceService.command({ ...context, grantId: body.operatorAction.grantId }, id, action, { expectedVersion: body.expectedVersion, reason: body.reason }, key);
  }
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  revokeSession(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OperatorSessionRevokeSchema)) body: z.infer<typeof OperatorSessionRevokeSchema>, @Headers('idempotency-key') key: string, @Req() request: AuthenticatedRequest) {
    const context = requireOperatorSession(request);
    assertOperatorOrigin(request);
    return this.deviceService.revokeSession(context, id, body, key);
  }
}
function cursorBoundary(cursor: string | undefined) {
  if (!cursor) return {};
  const [createdAt, id] = cursor.split('~');
  const time = new Date(createdAt);
  return { OR: [{ createdAt: { lt: time } }, { createdAt: time, id: { lt: id } }] };
}
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}~${row.id}`;
}
