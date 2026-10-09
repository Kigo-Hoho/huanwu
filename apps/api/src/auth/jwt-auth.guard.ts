import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthService, type AuthenticatedUser } from './auth.service.js';
import { OperatorSessionService } from '../operator-security/operator-session.service.js';
import type { OperatorSessionContext } from '../operator-security/operator-action.types.js';

export type AuthenticatedRequest = Request & { user: AuthenticatedUser; operatorSession?: OperatorSessionContext };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService, @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Bearer access token is required');
    }
    const principal = this.authService.verifyAccessToken(token);
    request.user = await this.authService.rehydrateAuthenticatedUser(principal);
    if (principal.sessionId) request.operatorSession = await this.sessions.fromRequest(request.user, principal.sessionId, request);
    return true;
  }
}
