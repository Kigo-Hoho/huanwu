import type { CaseDetailView, OrderSide } from '@barter/contracts';
import { Button, Text, View } from '@tarojs/components';
import { simulationDriversEnabled } from '../../features/orders/order-api';
import { buttonDisabled, buttonRole, money, sideLabel } from '../orders/shared';

export function CompensationActions({
  detail, orderVersion, mySide, busy, onRequest, onLoadCheckout, onTestComplete,
}: {
  detail: CaseDetailView;
  orderVersion: number;
  mySide: OrderSide | null;
  busy: boolean;
  onRequest: () => void;
  onLoadCheckout: (paymentId: string) => void;
  onTestComplete: (paymentId: string) => void;
}) {
  const sim = simulationDriversEnabled();
  const resolutionVersion = detail.currentResolutionVersion ?? 1;
  const mine = detail.compensation.filter(c => c.payerSide === mySide);
  const unknown = detail.compensation.some(c => c.status === 'UNKNOWN' || c.status === 'FAILED');
  return <View>
    <Text>补偿</Text>
    {detail.compensation.length === 0 && <Text>暂无补偿义务</Text>}
    {unknown && <Text>资金状态未知，请刷新核对，勿重复付款</Text>}
    {detail.compensation.map(c => <View key={c.obligationId}>
      <Text>{sideLabel(c.payerSide)} → {sideLabel(c.payeeSide)} · {money(c.amountFen)} · {c.status} · 截止 {c.paymentDeadline}</Text>
      {c.payerSide === mySide && c.status === 'PENDING' && !c.paymentId && detail.status === 'EXECUTING' && (
        <Button {...buttonRole} {...buttonDisabled(busy)} disabled={busy} onClick={() => { if (!busy) onRequest(); }}>发起补偿付款</Button>
      )}
      {c.payerSide === mySide && c.paymentId && ['PENDING', 'AUTHORIZED'].includes(c.status) && (
        <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy && c.paymentId) onLoadCheckout(c.paymentId); }}>查看补偿付款参数</Button>
      )}
      {sim && c.paymentId && c.payerSide === mySide && ['PENDING', 'AUTHORIZED', 'COLLECTED'].includes(c.status) && (
        <Button {...buttonRole} disabled={busy} onClick={() => { if (!busy && c.paymentId) onTestComplete(c.paymentId); }}>完成测试补偿</Button>
      )}
    </View>)}
    {mine.length === 0 && detail.compensation.length > 0 && <Text>当前身份不是明确付款方，无法发起补偿付款</Text>}
    <Text style={{ display: 'none' }}>{resolutionVersion}:{orderVersion}</Text>
  </View>;
}
