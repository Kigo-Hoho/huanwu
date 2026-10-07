import { OrderStatusSchema, type OrderStatus } from '@barter/contracts';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';

export const orderListQuerySchema = z.strictObject({ cursor: z.string().optional(), status: OrderStatusSchema.optional(), limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional() });
export interface OrderListQuery { cursor?: string; status?: OrderStatus; limit?: number }
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.string().uuid().toLowerCase() });
const invalidQuery = () => new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid order query' });
function decodeCursor(value: string) {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw invalidQuery();
    return cursorSchema.parse(JSON.parse(decoded));
  } catch { throw invalidQuery(); }
}
export function orderListQuery(query: OrderListQuery): { limit: number; after: Prisma.OrderWhereInput | undefined } {
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.status !== undefined && !OrderStatusSchema.safeParse(query.status).success)) throw invalidQuery();
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  return { limit, after: cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : undefined };
}
export function orderNextCursor(more: boolean, last?: { createdAt: Date; id: string }): string | null {
  return more && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null;
}
