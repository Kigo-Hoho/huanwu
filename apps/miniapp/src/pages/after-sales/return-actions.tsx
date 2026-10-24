import type { CaseDetailView, ReturnView } from '@barter/contracts';
import { Button, Input, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { alertRole, buttonDisabled, buttonRole, inputLabel, sideLabel } from '../orders/shared';

const statusLabels: Record<string, string> = {
  PENDING: '待登记', REGISTERED: '已寄出', COLLECTED: '已揽收', DELIVERED: '已送达',
  CONFIRMED: '已确认', DISPUTED: '有异议', INTERCEPTED: '已拦截', UNRETURNABLE: '无法归还', UNKNOWN: '状态未知',
};

export function ReturnActions({
  detail, returns, orderVersion, busy, onRegister, onConfirm,
}: {
  detail: CaseDetailView;
  returns: ReturnView[];
  orderVersion: number;
  busy: boolean;
  onRegister: (input: { expectedCaseVersion: number; expectedOrderVersion: number; resolutionVersion: number; obligationIds: string[]; obligationVersions: { obligationId: string; expectedVersion: number }[]; carrier: string; trackingNumber: string }) => void;
  onConfirm: (input: { expectedCaseVersion: number; expectedOrderVersion: number; resolutionVersion: number; obligationId: string; expectedObligationVersion: number; decision: 'CONFIRM' | 'DISPUTE'; reason?: string }) => void;
}) {
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [disputeReason, setDisputeReason] = useState('');
  const resolutionVersion = detail.currentResolutionVersion ?? 1;
  const pending = returns.filter(r => r.status === 'PENDING');
  const deliverable = returns.filter(r => ['DELIVERED', 'REGISTERED', 'COLLECTED'].includes(r.status));
  const abnormal = returns.filter(r => ['DISPUTED', 'UNKNOWN', 'UNRETURNABLE'].includes(r.status));
  return <View>
    <Text>退货进度</Text>
    {returns.length === 0 && <Text>当前无退货义务</Text>}
    {returns.map(r => <View key={r.id}>
      <Text>{statusLabels[r.status] ?? r.status} · 持有 {sideLabel(r.holderSide)} → 原主 {sideLabel(r.ownerSide)} · 版本 {r.version}</Text>
      {r.receiptDeadline && <Text>收货截止：{r.receiptDeadline}</Text>}
    </View>)}
    {abnormal.length > 0 && <Text {...alertRole}>退货异常，请核对后处理或联系客服</Text>}
    {pending.length > 0 && <View>
      <Input {...inputLabel('承运商')} value={carrier} disabled={busy} onInput={e => setCarrier(e.detail.value)} />
      <Input {...inputLabel('运单号')} value={tracking} disabled={busy} onInput={e => setTracking(e.detail.value)} />
      <Button {...buttonRole} {...buttonDisabled(busy || !carrier.trim() || !tracking.trim())} disabled={busy || !carrier.trim() || !tracking.trim()} onClick={() => {
        if (busy || !carrier.trim() || !tracking.trim()) return;
        onRegister({
          expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion,
          obligationIds: pending.map(r => r.id),
          obligationVersions: pending.map(r => ({ obligationId: r.id, expectedVersion: r.version })),
          carrier: carrier.trim().toUpperCase(), trackingNumber: tracking.trim().toUpperCase(),
        });
      }}>登记退货寄出</Button>
    </View>}
    {deliverable.map(r => <View key={`confirm:${r.id}`}>
      <Button {...buttonRole} disabled={busy} onClick={() => {
        if (busy) return;
        onConfirm({ expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion, obligationId: r.id, expectedObligationVersion: r.version, decision: 'CONFIRM' });
      }}>确认收到退货</Button>
      <Input {...inputLabel('退货异议原因')} value={disputeReason} disabled={busy} onInput={e => setDisputeReason(e.detail.value)} />
      <Button {...buttonRole} {...buttonDisabled(busy || !disputeReason.trim())} disabled={busy || !disputeReason.trim()} onClick={() => {
        if (busy || !disputeReason.trim()) return;
        onConfirm({ expectedCaseVersion: detail.version, expectedOrderVersion: orderVersion, resolutionVersion, obligationId: r.id, expectedObligationVersion: r.version, decision: 'DISPUTE', reason: disputeReason.trim() });
      }}>提出退货异议</Button>
    </View>)}
  </View>;
}
