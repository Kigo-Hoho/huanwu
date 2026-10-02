import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProposalsService } from './proposals.service.js';

@Injectable()
export class ProposalExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(ProposalExpiryScheduler.name);
  constructor(@Inject(ProposalsService) private readonly proposals: ProposalsService) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.proposals.expireDue(); }
    catch (error) { this.logger.error('Proposal expiry sweep failed; next sweep will retry', error); }
    finally { this.running = false; }
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
