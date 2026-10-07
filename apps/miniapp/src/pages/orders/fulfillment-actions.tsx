import { OrderShipmentSchema, type OrderPartyView, type OrderView } from '@barter/contracts';
import { Button, Input, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { simulationDriversEnabled, type OrderAction } from '../../features/orders/order-api';
import { buttonRole, buttonDisabled, inputLabel } from './shared';

export function FulfillmentActions({ order, own, busy, onCommand }: {
  order: OrderView; own: OrderPartyView; busy: boolean;
  onCommand: (action: OrderAction, input: unknown, resourceId?: string) => Promise<void>;
}) {
  const [carrier, setCarrier] = useState(''); const [trackingNumber, setTracking] = useState('');
  const shipment = OrderShipmentSchema.safeParse({ expectedVersion: order.version, carrier, trackingNumber });
  const courier = order.terms.deliveryMode === 'COURIER';
  const canSend = order.status === 'AWAITING_FULFILLMENT' && !own.outgoingShipment && (courier || own.handedOverAt === null);
  return <View>
    {courier && canSend && <View>
      <Text>承运人</Text><Input {...inputLabel('承运人')} value={carrier} disabled={busy} onInput={e => setCarrier(e.detail.value)} />
      <Text>运单号</Text><Input {...inputLabel('运单号')} value={trackingNumber} disabled={busy} onInput={e => setTracking(e.detail.value)} />
      <Button {...buttonRole} {...buttonDisabled(busy || !shipment.success)} disabled={busy || !shipment.success} onClick={() => { if (!busy && shipment.success) void onCommand('shipment', shipment.data); }}>登记我的运单</Button>
      <Text>登记运单不等于已揽收，以可信物流刷新为准</Text>
    </View>}
    {!courier && canSend && !own.incomingDeliveredAt && <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void onCommand('handover', { expectedVersion: order.version }); }}>确认我已交出物品</Button>}
    {courier && own.outgoingShipment && order.simulation && simulationDriversEnabled() && ['REGISTERED', 'COLLECTED'].includes(own.outgoingShipment.status) && <Button {...buttonRole} disabled={busy} onClick={() => {
      if (!busy) void onCommand('testShipment', { expectedVersion: order.version, progress: own.outgoingShipment!.status === 'REGISTERED' ? 'COLLECTED' : 'DELIVERED' }, own.outgoingShipment!.id);
    }}>{own.outgoingShipment.status === 'REGISTERED' ? '测试我的去件已揽收' : '测试我的去件已送达'}</Button>}
    {own.incomingDeliveredAt && !own.acceptedAt && <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy) void onCommand('acceptance', { expectedVersion: order.version }); }}>验收我的来件</Button>}
  </View>;
}
