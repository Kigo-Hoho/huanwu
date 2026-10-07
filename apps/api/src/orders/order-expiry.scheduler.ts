import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OrderExpiryService } from './order-expiry.service.js';

@Injectable()
export class OrderExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(OrderExpiryScheduler.name);
  constructor(@Inject(OrderExpiryService) private readonly expiry: OrderExpiryService) {}
  onModuleInit(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.expiry.reconcileDue()
      .catch(error => { this.logger.error('Order expiry sweep failed; next sweep will retry', error); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
