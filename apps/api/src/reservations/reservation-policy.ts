import type { ItemReservation } from '../generated/prisma/client.js';

export function reservationIsAvailable(reservation: ItemReservation | null, now: Date): boolean {
  if (!reservation) return true;
  if (reservation.orderId) return false;
  return reservation.expiresAt !== null && reservation.expiresAt <= now;
}
