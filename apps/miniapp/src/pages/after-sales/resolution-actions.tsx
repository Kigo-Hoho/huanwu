import type { CaseDetailView } from '@barter/contracts';
import { Button, Input, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { buttonDisabled, buttonRole, inputLabel, money, sideLabel } from '../orders/shared';

const typeLabels: Record<string, string> = {
  CONTINUE_EXCHANGE: '继续交换', RETURN_ORIGINALS: '原物归还', KEEP_WITH_COMPENSATION: '保留并补偿',
  CANCEL_BEFORE_HANDOVER: '交接前取消', FUNDS_ONLY: '仅资金处理',
};
const responsibilityLabels: Record<string, string> = {
  NONE: '无责任划分', INITIATOR: '发起方', RECIPIENT: '接收方', BOTH: '双方', UNDETERMINED: '待核定',
};

export function ResolutionActions({
  detail, orderVersion, busy, onConsent, onConfirmKeep,
}: {
  detail: CaseDetailView;
  orderVersion: number;
  busy: boolean;
  onConsent: (decision: 'AGREE' | 'REJECT', reason?: string) => void;
  onConfirmKeep: () => void;
}) {
  const current = detail.resolutions.find(r => r.number === detail.currentResolutionVersion) ?? detail.resolutions[detail.resolutions.length - 1];
  const [rejectReason, setRejectReason] = useState('');
  if (!current) return <Text>暂无方案</Text>;
  const showConsent = ['AWAITING_AGREEMENT', 'EXECUTING'].includes(detail.status);
  const showKeep = detail.status === 'EXECUTING' && current.type === 'KEEP_WITH_COMPENSATION';
  return <View>
    <Text>当前方案 · 第 {current.number} 版 · {typeLabels[current.type] ?? current.type}</Text>
    <Text>责任：{responsibilityLabels[current.responsibility] ?? current.responsibility}</Text>
    <Text>净补偿：{money(current.netCompensation.amountFen)} · {current.netCompensation.payer === 'NONE' ? '无需付款' : sideLabel(current.netCompensation.payer) + '付款'}</Text>
    <Text>订单结果：{current.orderOutcome}</Text>
    <Text>方案说明：{current.reason}</Text>
    {current.consents.map(c => <Text key={`${c.side}:${c.createdAt}`}>{sideLabel(c.side)}：{c.decision === 'AGREE' ? '已同意' : '已拒绝'}{c.reason ? ` · ${c.reason}` : ''}</Text>)}
    {showConsent && <View>
      <Button {...buttonRole} {...buttonDisabled(busy)} disabled={busy} onClick={() => { if (!busy) onConsent('AGREE'); }}>同意当前方案</Button>
      <Input {...inputLabel('拒绝原因')} value={rejectReason} disabled={busy} onInput={e => setRejectReason(e.detail.value)} />
      <Button {...buttonRole} {...buttonDisabled(busy || !rejectReason.trim())} disabled={busy || !rejectReason.trim()} onClick={() => { if (!busy && rejectReason.trim()) onConsent('REJECT', rejectReason.trim()); }}>拒绝当前方案</Button>
    </View>}
    {showKeep && <Button {...buttonRole} {...buttonDisabled(busy)} disabled={busy} onClick={() => { if (!busy) onConfirmKeep(); }}>确认保留物品</Button>}
  </View>;
}
