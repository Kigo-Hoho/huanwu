import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './auth.service.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

export function assertPureCustomer(actor: AuthenticatedUser): void {
  if (!actor.roles.includes('CUSTOMER') || actor.roles.some(role => role !== 'CUSTOMER')) {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'A pure customer session is required' });
  }
}
@Injectable()
export class CustomerOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    assertPureCustomer(context.switchToHttp().getRequest<AuthenticatedRequest>().user);
    return true;
  }
}
