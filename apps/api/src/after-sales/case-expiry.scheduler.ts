import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CaseExpiryService } from './case-expiry.service.js';

@Injectable()
export class CaseExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(CaseExpiryScheduler.name);
  constructor(@Inject(CaseExpiryService) private readonly expiry: CaseExpiryService) {}
  onModuleInit(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.expiry.reconcileDue()
      .catch(error => { this.logger.error('Case expiry sweep failed; next sweep will retry', error); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
