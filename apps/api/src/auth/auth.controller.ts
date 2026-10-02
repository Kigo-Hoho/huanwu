import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  AuthService,
  type AuthenticatedUser,
  type AuthSession,
} from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

const wechatLoginSchema = z.object({
  code: z.string().trim().min(1).max(512),
});
const adminLoginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(1024),
});

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('auth/wechat')
  @UsePipes(new ZodValidationPipe(wechatLoginSchema))
  authenticateWechat(
    @Body() body: z.infer<typeof wechatLoginSchema>,
  ): Promise<AuthSession> {
    return this.authService.authenticateWechat(body.code);
  }

  @Post('auth/admin/password')
  @UsePipes(new ZodValidationPipe(adminLoginSchema))
  authenticateAdmin(
    @Body() body: z.infer<typeof adminLoginSchema>,
  ): Promise<AuthSession> {
    return this.authService.authenticateAdmin(body.email, body.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  currentSession(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Get('admin/session')
  @Roles('OPERATIONS', 'REVIEWER', 'SUPER_ADMIN')
  @UseGuards(JwtAuthGuard, RolesGuard)
  adminSession(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
