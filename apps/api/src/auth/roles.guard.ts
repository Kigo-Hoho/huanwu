import type { Role } from '@barter/contracts';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { ROLES_METADATA_KEY } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(
      ROLES_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (
      !requiredRoles?.length ||
      !user ||
      !requiredRoles.some((role) => user.roles.includes(role))
    ) {
      throw new ForbiddenException('Required role is missing');
    }

    return true;
  }
}
