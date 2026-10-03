import { Injectable } from '@nestjs/common';
import type { IntegrationOperationKind } from '../generated/prisma/client.js';
import type { IntegrationOperationHandler } from './integration.types.js';

@Injectable()
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<IntegrationOperationKind, IntegrationOperationHandler>();
  register(kind: IntegrationOperationKind, handler: IntegrationOperationHandler): void {
    if (this.handlers.has(kind)) throw new Error('Integration handler already registered');
    this.handlers.set(kind, handler);
  }
  get(kind: IntegrationOperationKind): IntegrationOperationHandler | undefined { return this.handlers.get(kind); }
}
