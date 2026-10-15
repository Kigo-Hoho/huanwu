import { Module } from '@nestjs/common';
import { TradingRestrictionsService } from './trading-restrictions.service.js';
// Kept independent of RiskModule's readers/controllers to avoid a cycle through
// OrdersModule -> ProposalsModule -> trading admission.
@Module({ providers: [TradingRestrictionsService], exports: [TradingRestrictionsService] })
export class TradingRestrictionsModule {}
