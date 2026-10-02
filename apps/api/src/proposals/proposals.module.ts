import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProposalsController } from './proposals.controller.js';
import { ProposalsService } from './proposals.service.js';
import { ProposalExpiryScheduler } from './proposal-expiry.scheduler.js';
import { AdminProposalsController } from './admin-proposals.controller.js';
import { ClockModule } from '../common/clock.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { ProposalOrderHandoffService } from './proposal-order-handoff.service.js';

@Module({ imports: [AuthModule, AuditModule, ClockModule, ReservationsModule], controllers: [ProposalsController, AdminProposalsController], providers: [ProposalsService, ProposalExpiryScheduler, ProposalOrderHandoffService], exports: [ProposalsService, ProposalOrderHandoffService] })
export class ProposalsModule {}
