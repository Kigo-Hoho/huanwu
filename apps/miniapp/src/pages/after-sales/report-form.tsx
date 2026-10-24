import { CreateRiskReportSchema, type CreateRiskReportInput, type RiskReason, type RiskTargetType } from '@barter/contracts';
import { Button, Input, Picker, Text, View } from '@tarojs/components';
import { useState } from 'react';
import { alertRole, buttonDisabled, buttonRole, inputLabel } from '../orders/shared';

const reasons: RiskReason[] = ['PROHIBITED_ITEM', 'FALSE_SHIPMENT', 'FRAUDULENT_TRADE', 'OTHER'];
const reasonLabels: Record<RiskReason, string> = {
  PROHIBITED_ITEM: '违禁物品', FALSE_SHIPMENT: '虚假运单', FRAUDULENT_TRADE: '欺诈交易', OTHER: '其他',
};

export function ReportForm({
  targetType, targetId, expectedTargetVersion, visible, onSubmit, busy = false,
}: {
  targetType: RiskTargetType;
  targetId: string;
  expectedTargetVersion: number;
  visible: boolean;
  onSubmit: (input: CreateRiskReportInput) => Promise<unknown>;
  busy?: boolean;
}) {
  const [reason, setReason] = useState<RiskReason>('PROHIBITED_ITEM');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  if (!visible) return null;
  const parsed = CreateRiskReportSchema.safeParse({ targetType, targetId, expectedTargetVersion, reason, description });
  return <View>
    <Text>举报</Text>
    <Picker mode='selector' range={reasons.map(r => reasonLabels[r])} value={reasons.indexOf(reason)} onChange={e => setReason(reasons[Number(e.detail.value)]!)}>
      <Text>原因：{reasonLabels[reason]}</Text>
    </Picker>
    <Input {...inputLabel('举报说明')} value={description} disabled={busy} onInput={e => setDescription(e.detail.value)} />
    {error && <Text {...alertRole}>{error}</Text>}
    <Button {...buttonRole} {...buttonDisabled(busy || !parsed.success)} disabled={busy || !parsed.success} onClick={() => {
      if (!parsed.success || busy) return;
      setError('');
      void onSubmit(parsed.data).catch(() => setError('举报未提交成功，请刷新后重试。'));
    }}>提交举报</Button>
  </View>;
}
