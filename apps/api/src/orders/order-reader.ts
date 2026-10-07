import { Prisma, type Order, type OrderCancellation } from '../generated/prisma/client.js';
import { orderInclude, type LockedOrder, type OrderTx } from './order.mapper.js';

// Prisma's application-level relation strategy dispatches sibling queries on the
// same transaction client. Load the five safe projections sequentially instead.
// Lists batch by page so this stays six queries regardless of page size.
export async function readOrderRelations(tx: OrderTx, orders: Order[]): Promise<LockedOrder[]> {
  if (orders.length === 0) return [];
  const where = { orderId: { in: orders.map(order => order.id) } };
  const items = await tx.orderItemSnapshot.findMany({ where, ...orderInclude.items });
  const parties = await tx.orderPartyProgress.findMany({ where, ...orderInclude.parties });
  const payments = await tx.paymentIntent.findMany({ where, ...orderInclude.payments });
  const shipments = await tx.shipment.findMany({ where });
  // Bound history at the database to one latest request per order. The revision
  // breaks equal timestamps deterministically even when commands share a clock tick.
  const cancellations = await tx.$queryRaw<OrderCancellation[]>(Prisma.sql`
    SELECT DISTINCT ON ("orderId") * FROM "OrderCancellation"
    WHERE "orderId" IN (${Prisma.join(orders.map(order => Prisma.sql`${order.id}::uuid`))})
    ORDER BY "orderId", "requestedAt" DESC, "requestedVersion" DESC, "id" DESC
  `);
  return orders.map(order => ({
    ...order, items: items.filter(item => item.orderId === order.id),
    parties: parties.filter(party => party.orderId === order.id),
    payments: payments.filter(payment => payment.orderId === order.id),
    shipments: shipments.filter(shipment => shipment.orderId === order.id),
    cancellations: cancellations.filter(cancellation => cancellation.orderId === order.id).slice(0, 1),
  }));
}
export async function readOrder(tx: OrderTx, id: string): Promise<LockedOrder | null> {
  const order = await tx.order.findUnique({ where: { id } });
  return order ? (await readOrderRelations(tx, [order]))[0]! : null;
}
