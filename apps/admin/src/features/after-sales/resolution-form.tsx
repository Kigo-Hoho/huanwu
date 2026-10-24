import {
  type AdminCaseDetailView,
  type AdminResolutionContext,
  type ResolutionInput,
  type ResolutionType,
} from '@barter/contracts';
import { Alert, Button, Input, Select } from 'antd';
import { useEffect, useState } from 'react';
import type { AdminAfterSalesApi } from '../../lib/after-sales-api';
import { ApiError } from '../../lib/api-client';

export type ResolutionFormProps = {
  detail: AdminCaseDetailView;
  client: Pick<AdminAfterSalesApi, 'proposeResolution' | 'getCase'>;
  onProposed: (detail: AdminCaseDetailView) => void;
  disabled?: boolean;
};

function emptyCompensation() {
  return {
    originalDifferenceReversal: { amountFen: 0, payer: 'NONE' as const },
    initiatorExtraFen: 0,
    recipientExtraFen: 0,
    initiatorShippingFen: 0,
    recipientShippingFen: 0,
  };
}

function buildDraft(
  detail: AdminCaseDetailView,
  type: ResolutionType,
  reason: string,
  context: AdminResolutionContext | undefined,
): ResolutionInput | null {
  if (!context) return null;
  const snapshots = context.itemSnapshots;
  if (snapshots.length < 2) return null;
  const originalFunds = context.originalPayments.map((payment) => ({
    paymentIntentId: payment.paymentIntentId,
    destination:
      type === 'CONTINUE_EXCHANGE'
        ? ('RETAIN_FOR_EXCHANGE' as const)
        : ('REFUND_PAYER' as const),
  }));
  const returnPlan =
    type === 'RETURN_ORIGINALS' || type === 'CANCEL_BEFORE_HANDOVER'
      ? snapshots.map((snapshot) => ({
          itemSnapshotId: snapshot.id,
          outcome:
            snapshot.deliveryState === 'UNDELIVERED'
              ? ('UNDELIVERED' as const)
              : ('RETURN_ORIGINAL' as const),
        }))
      : [];
  const terminal = context.orderStatus === 'COMPLETED' || context.orderStatus === 'CANCELLED';
  const orderOutcome =
    type === 'CONTINUE_EXCHANGE'
      ? ('RESUME' as const)
      : type === 'KEEP_WITH_COMPENSATION'
        ? ('COMPLETE' as const)
        : type === 'FUNDS_ONLY' || terminal
          ? ('PRESERVE_TERMINAL' as const)
          : ('CANCEL' as const);
  return {
    expectedCaseVersion: detail.version,
    expectedOrderVersion: context.orderVersion,
    resolutionVersion: (detail.currentResolutionVersion ?? 0) + 1,
    type,
    reason,
    rulesVersion: 'phase4-simulation-v1',
    evidenceIds: detail.evidence.map((item) => item.id),
    itemSnapshotIds: snapshots.map((item) => item.id),
    responsibility: 'UNDETERMINED',
    originalFunds,
    returnPlan,
    compensationComponents: emptyCompensation(),
    netCompensation: { amountFen: 0, payer: 'NONE' },
    orderOutcome,
  };
}

export function ResolutionForm({ detail, client, onProposed, disabled }: ResolutionFormProps) {
  const [type, setType] = useState<ResolutionType>('RETURN_ORIGINALS');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setType('RETURN_ORIGINALS');
    setReason('');
    setError('');
    setNotice('');
  }, [detail.id, detail.version]);

  const submit = async () => {
    if (!reason.trim()) {
      setError('请填写方案原因');
      return;
    }
    const draft = buildDraft(detail, type, reason.trim(), detail.resolutionContext);
    if (!draft) {
      setError('缺少方案上下文，无法起草（需订单快照与原支付）');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const key = `propose:${detail.id}:v${detail.version}`;
    try {
      await client.proposeResolution(detail.id, draft, key);
      const next = await client.getCase(detail.id);
      setNotice('方案已起草（资金动作仅为模拟，不会发起真实支付或物流）');
      onProposed(next);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? `${cause.code}：${cause.message}` : cause instanceof Error ? cause.message : '起草失败',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="resolution-form" aria-label="起草处理方案">
      <h2>起草处理方案</h2>
      <Alert type="info" showIcon message="后台资金动作仅为模拟，不会发起真实支付或物流。" />
      <label>
        方案类型
        <Select
          aria-label="方案类型"
          value={type}
          disabled={disabled || busy}
          style={{ width: '100%' }}
          onChange={(value) => setType(value)}
          options={[
            { value: 'CONTINUE_EXCHANGE', label: '继续交换' },
            { value: 'RETURN_ORIGINALS', label: '退回原物' },
            { value: 'KEEP_WITH_COMPENSATION', label: '保留并补偿' },
            { value: 'CANCEL_BEFORE_HANDOVER', label: '交接前取消' },
            { value: 'FUNDS_ONLY', label: '仅资金（终态）' },
          ]}
        />
      </label>
      <label>
        方案原因
        <Input.TextArea
          aria-label="方案原因"
          value={reason}
          disabled={disabled || busy}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
        />
      </label>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="success" showIcon message={notice} /> : null}
      <Button type="primary" disabled={disabled || busy} onClick={() => void submit()}>
        提交方案草稿
      </Button>
    </section>
  );
}
