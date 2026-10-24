import { Injectable } from '@nestjs/common';
@Injectable()
export class OrderFactsService {
  private readonly listeners = new Set<(orderId: string) => Promise<void>>();
  subscribe(listener: (orderId: string) => Promise<void>) { this.listeners.add(listener); }
  // Call after the fact transaction commits; listeners acquire a fresh order lock.
  async notify(orderId: string) { for (const listener of this.listeners) await listener(orderId); }
}
