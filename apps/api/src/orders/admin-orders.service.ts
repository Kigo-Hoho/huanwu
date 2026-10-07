import type { OrderListView, OrderView } from '@barter/contracts';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { mapOrder } from './order.mapper.js';
import { orderListQuery, orderNextCursor, type OrderListQuery } from './order-list-query.js';
import { readOrder, readOrderRelations } from './order-reader.js';

// Operations reads persisted facts only: no participant commands or expiry reconciliation.
@Injectable()
export class AdminOrdersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  detail(id: string): Promise<OrderView> {
    return this.prisma.$transaction(async tx => {
      const order = await readOrder(tx, id);
      if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      return mapOrder(order);
    }, { isolationLevel: 'RepeatableRead' });
  }

  list(query: OrderListQuery): Promise<OrderListView> {
    const { limit, after } = orderListQuery(query);
    return this.prisma.$transaction(async tx => {
      const orders = await tx.order.findMany({ where: { ...(after ? { AND: [after] } : {}), ...(query.status ? { status: query.status } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const page = orders.slice(0, limit);
      return { items: (await readOrderRelations(tx, page)).map(mapOrder), nextCursor: orderNextCursor(orders.length > limit, page.at(-1)) };
    }, { isolationLevel: 'RepeatableRead' });
  }
}
