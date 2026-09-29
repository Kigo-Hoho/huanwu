import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProposalsController } from './proposals.controller.js';
import { ProposalsService } from './proposals.service.js';
import { ProposalExpiryScheduler } from './proposal-expiry.scheduler.js';

@Module({ imports: [AuthModule, AuditModule], controllers: [ProposalsController], providers: [ProposalsService, ProposalExpiryScheduler] })
export class ProposalsModule {}
