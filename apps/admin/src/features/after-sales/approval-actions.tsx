import type { AdminCaseDetailView, AdminResolutionView, Role } from '@barter/contracts';
import { Alert, Button, Input } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  loadBoundOperatorSession,
  type AdminAfterSalesApi,
} from '../../lib/after-sales-api';
import { ApiError, loadStoredSession } from '../../lib/api-client';
import { ReauthDialog } from '../security/reauth-dialog';

export type ApprovalActionsProps = {
  detail: AdminCaseDetailView;
  currentRoles: Role[];
  client: Pick<AdminAfterSalesApi, 'approveFunds' | 'executeFunds' | 'adjudicate' | 'getCase' | 'onIdentityChange' | 'clearSensitiveState'>;
  onUpdated: (detail: AdminCaseDetailView) => void;
  forceShowFundsEntry?: boolean;
};

type PendingAction = 'approve' | 'execute' | 'adjudicate' | null;

function approvalRecords(detail: AdminCaseDetailView, resolution: AdminResolutionView | undefined) {
  if (!resolution) return [];
  return detail.records.filter(
    (record) =>
      record.kind === 'RESOLUTION_APPROVED' &&
      record.actorKind === 'PLATFORM' &&
      record.description.length > 0,
  );
}

export function ApprovalActions({
  detail,
  currentRoles,
  client,
  onUpdated,
  forceShowFundsEntry = false,
}: ApprovalActionsProps) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState('');
  const [width, setWidth] = useState(() => window.innerWidth);
  const bound = loadBoundOperatorSession();
  const session = loadStoredSession();

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setReason('');
    setPending(null);
    setError('');
    setBlocked('');
  }, [detail.id, detail.version]);

  useEffect(() => {
    return client.onIdentityChange(() => {
      setReason('');
      setPending(null);
      setError('');
      setBlocked('');
    });
  }, [client]);

  const currentResolution = useMemo(
    () =>
      detail.resolutions.find((item) => item.number === detail.currentResolutionVersion) ??
      detail.resolutions[detail.resolutions.length - 1],
    [detail],
  );
  const approvals = approvalRecords(detail, currentResolution);
  const isSuperAdmin = currentRoles.includes('SUPER_ADMIN');
  const isOperationsOnly = currentRoles.includes('OPERATIONS') && !isSuperAdmin;
  const isDesktop =
    forceShowFundsEntry ||
    (width >= 768 && bound?.capability === 'DESKTOP_PRIVILEGED');
  const canOpenFunds = isSuperAdmin && isDesktop;
  const orderVersion = detail.resolutionContext?.orderVersion;

  const runSensitive = async (action: Exclude<PendingAction, null>, password: string) => {
    if (!currentResolution || orderVersion == null) {
      setError('缺少当前方案或订单版本，无法执行');
      setPending(null);
      return;
    }
    if (!reason.trim()) {
      setError('请填写操作原因');
      setPending(null);
      return;
    }
    setBusy(true);
    setError('');
    setBlocked('');
    const body = {
      expectedCaseVersion: detail.version,
      expectedOrderVersion: orderVersion,
      resolutionVersion: currentResolution.number,
      reason: reason.trim(),
      ...(action === 'adjudicate' ? { evidenceIds: detail.evidence.map((item) => item.id) } : {}),
    };
    const key = `${action}:${detail.id}:r${currentResolution.number}:v${detail.version}`;
    try {
      if (action === 'approve') {
        await client.approveFunds(detail.id, body, password, key);
      } else if (action === 'execute') {
        await client.executeFunds(detail.id, body, password, key);
      } else {
        await client.adjudicate(detail.id, body as typeof body & { evidenceIds: string[] }, password, key);
      }
      const next = await client.getCase(detail.id);
      onUpdated(next);
      setPending(null);
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.code === 'APPROVAL_REQUIRED' || cause.code === 'RISK_BLOCKS_RESUME') {
          setBlocked(`${cause.code}：${cause.message}`);
        } else {
          setError(`${cause.code}：${cause.message}`);
        }
      } else {
        setError(cause instanceof Error ? cause.message : '操作失败');
      }
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="approval-actions" aria-label="审批与执行">
      <h2>审批与执行</h2>
      <Alert type="info" showIcon message="资金处置仅为模拟；需两名不同超级管理员批准，且仅桌面受信会话可开放入口。" />
      {currentResolution ? (
        <p>
          当前方案 v{currentResolution.number} · {currentResolution.type}
        </p>
      ) : (
        <p>尚无方案版本</p>
      )}
      <div aria-label="资金批准状态">
        <h3>资金批准状态</h3>
        {approvals.length === 0 ? (
          <p>尚未收到管理员批准</p>
        ) : (
          <ol>
            {approvals.map((record, index) => (
              <li key={record.id} aria-label={`批准记录 ${index + 1}`}>
                批准 {index + 1}（平台）· {record.description} · {record.createdAt}
              </li>
            ))}
          </ol>
        )}
        {approvals.length < 2 ? <p role="status">仍缺 {2 - approvals.length} 名不同超级管理员批准</p> : <p role="status">两名管理员批准已齐</p>}
      </div>
      {blocked ? <Alert type="warning" showIcon message={blocked} /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <label>
        操作原因
        <Input.TextArea
          aria-label="审批操作原因"
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
        />
      </label>
      {isOperationsOnly ? (
        <Alert type="warning" showIcon message="客服不可执行资金批准或资金执行；请转交超级管理员桌面会话。" />
      ) : null}
      {!canOpenFunds && isSuperAdmin ? (
        <Alert type="warning" showIcon message="当前为移动或未绑定桌面能力会话，资金审批入口未开放。" />
      ) : null}
      {canOpenFunds ? (
        <div className="funds-actions" aria-label="资金审批入口">
          <Button disabled={busy || !currentResolution} onClick={() => setPending('approve')}>
            批准资金方案
          </Button>
          <Button disabled={busy || !currentResolution || approvals.length < 2} onClick={() => setPending('execute')}>
            执行资金方案
          </Button>
          <Button disabled={busy || !currentResolution} onClick={() => setPending('adjudicate')}>
            运营裁决
          </Button>
        </div>
      ) : null}
      {!session ? <Alert type="error" message="AUTH_REQUIRED：请重新登录" /> : null}
      <ReauthDialog
        open={pending !== null}
        title={pending === 'execute' ? '重新验证后执行资金' : pending === 'adjudicate' ? '重新验证后裁决' : '重新验证后批准资金'}
        summary={`将固定当前工单 v${detail.version} / 方案 v${currentResolution?.number ?? '-'} 正文后签发一次性授权。`}
        busy={busy}
        error={error}
        onCancel={() => setPending(null)}
        onConfirm={(password) => {
          if (pending) void runSensitive(pending, password);
        }}
      />
    </section>
  );
}
