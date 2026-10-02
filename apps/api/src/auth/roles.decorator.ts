import type { Role } from '@barter/contracts';
import { SetMetadata } from '@nestjs/common';

export const ROLES_METADATA_KEY = 'required_roles';

export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_METADATA_KEY, roles);
