import type { AdminCaseDetailView, Role } from '@barter/contracts';
import { Alert, Button, Card, Empty, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminAfterSalesApi, type AdminAfterSalesApi } from '../../lib/after-sales-api';
import { ApiError, loadStoredSession } from '../../lib/api-client';
import { formatFen, formatUtc } from '../review/review-queue-page';
import { caseStatusLabels } from './case-list-page';
import { ApprovalActions } from './approval-actions';
import { ResolutionForm } from './resolution-form';

export type CaseDetailPageProps = {
  client?: Pick<
    AdminAfterSalesApi,
    | 'getCase'
    | 'requestEvidence'
    | 'rejectCase'
    | 'proposeResolution'
    | 'approveFunds'
    | 'executeFunds'
    | 'adjudicate'
    | 'onIdentityChange'
    | 'clearSensitiveState'
    | 'getIdentityEpoch'
  >;
  caseId?: string;
  currentRoles?: Role[];
};

const actorLabel = (kind: string) =>
  kind === 'PLATFORM' ? '平台' : kind === 'SYSTEM' ? '系统' : '用户';

export function CaseDetailPage({
  client = adminAfterSalesApi,
  caseId: caseIdProp,
  currentRoles,
}: CaseDetailPageProps) {
  const params = useParams();
  const caseId = caseIdProp ?? params.caseId ?? '';
  const roles = currentRoles ?? loadStoredSession()?.user.roles ?? [];
  const [detail, setDetail] = useState<AdminCaseDetailView | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [evidenceReason, setEvidenceReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [epoch, setEpoch] = useState(() => client.getIdentityEpoch());

  useEffect(() => {
    return client.onIdentityChange(() => {
      setDetail(null);
      setEvidenceReason('');
      setRejectReason('');
      setError('');
      setEpoch(client.getIdentityEpoch());
    });
  }, [client]);

  useEffect(() => {
    if (!caseId) return;
    let active = true;
    const loadEpoch = client.getIdentityEpoch();
    setBusy(true);
    setError('');
    setDetail(null);
    void client
      .getCase(caseId)
      .then((value) => {
        if (!active) return;
        if (client.getIdentityEpoch() !== loadEpoch) return;
        setDetail(value);
        setBusy(false);
      })
      .catch((cause) => {
        if (!active) return;
        if (client.getIdentityEpoch() !== loadEpoch) return;
        setError(
          cause instanceof ApiError
            ? `${cause.code}：${cause.message}`
            : cause instanceof Error
              ? cause.message
              : '加载失败',
        );
        setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [caseId, client, retry, epoch]);

  const requestEvidence = async () => {
    if (!detail || !evidenceReason.trim() || !detail.resolutionContext) return;
    try {
      await client.requestEvidence(
        detail.id,
        {
          expectedCaseVersion: detail.version,
          expectedOrderVersion: detail.resolutionContext.orderVersion,
          side: 'INITIATOR',
          reason: evidenceReason.trim(),
        },
        `evidence:${detail.id}:v${detail.version}`,
      );
      setDetail(await client.getCase(detail.id));
      setEvidenceReason('');
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '补证失败');
    }
  };

  const rejectCase = async () => {
    if (!detail || !rejectReason.trim() || !detail.resolutionContext) return;
    try {
      await client.rejectCase(
        detail.id,
        {
          expectedCaseVersion: detail.version,
          expectedOrderVersion: detail.resolutionContext.orderVersion,
          reason: rejectReason.trim(),
        },
        `reject:${detail.id}:v${detail.version}`,
      );
      setDetail(await client.getCase(detail.id));
      setRejectReason('');
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '驳回失败');
    }
  };

  return (
    <main className="workspace-page after-sales-page">
      <Typography.Title level={1}>售后工单详情</Typography.Title>
      <p>
        <Link to="/after-sales">返回列表</Link>
      </p>
      {busy ? <p role="status">加载工单详情中</p> : null}
      {error ? (
        <div>
          <Alert type="error" showIcon message={error} />
          <Button aria-label="重试" onClick={() => setRetry((value) => value + 1)}>
            重试
          </Button>
        </div>
      ) : null}
      {!busy && !detail && !error ? <Empty description="工单不存在" /> : null}
      {detail ? (
        <>
          <Card title={`工单 ${detail.id}`}>
            <p>
              {caseStatusLabels[detail.status]} · v{detail.version}
            </p>
            <p>订单 {detail.orderId}</p>
            <p>原因：{detail.reason}</p>
            <p>创建：{formatUtc(detail.createdAt)}</p>
            <Alert type="info" showIcon message="后台资金动作仅为模拟，不会发起真实支付或物流。" />
          </Card>

          <Card title="平台处理时间线" aria-label="平台处理时间线">
            {detail.records.length === 0 ? (
              <Empty description="暂无处理记录" />
            ) : (
              <ol>
                {detail.records.map((record) => (
                  <li key={record.id}>
                    {record.actorKind === 'PLATFORM'
                      ? '平台（非用户）'
                      : actorLabel(record.actorKind)}{' '}
                    · {record.kind} · {record.description} · {formatUtc(record.createdAt)}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="证据（脱敏）" aria-label="证据列表">
            {detail.evidence.length === 0 ? (
              <Empty description="暂无证据" />
            ) : (
              <ul>
                {detail.evidence.map((item) => (
                  <li key={item.id}>
                    {item.description} · {formatUtc(item.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="归还逐项计划" aria-label="归还逐项计划">
            {(detail.resolutions.at(-1)?.returnPlan.length ?? 0) === 0 ? (
              <p>当前方案无归还义务</p>
            ) : (
              <ul>
                {detail.resolutions.at(-1)!.returnPlan.map((item) => (
                  <li key={item.itemSnapshotId}>
                    快照 {item.itemSnapshotId} · {item.outcome}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="资金原号核验进度" aria-label="资金原号核验进度">
            {!detail.resolutionContext?.originalPayments.length ? (
              <p>暂无原支付上下文</p>
            ) : (
              <ul>
                {detail.resolutionContext.originalPayments.map((payment) => (
                  <li key={payment.paymentIntentId}>
                    {payment.purpose} · {payment.paymentIntentId} · {payment.status} · 应付{' '}
                    {formatFen(payment.amountFen)} · 已收 {formatFen(payment.collectedFen)} · 已退{' '}
                    {formatFen(payment.refundedFen)} · 已结 {formatFen(payment.settledFen)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <section aria-label="补证与驳回">
            <label>
              补证原因
              <input
                aria-label="补证原因"
                value={evidenceReason}
                onChange={(event) => setEvidenceReason(event.target.value)}
              />
            </label>
            <Button onClick={() => void requestEvidence()}>要求补证</Button>
            <label>
              驳回原因
              <input
                aria-label="驳回原因"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
              />
            </label>
            <Button danger onClick={() => void rejectCase()}>
              驳回工单
            </Button>
          </section>

          <ResolutionForm detail={detail} client={client} onProposed={setDetail} />
          <ApprovalActions detail={detail} currentRoles={roles} client={client} onUpdated={setDetail} />
        </>
      ) : null}
    </main>
  );
}
