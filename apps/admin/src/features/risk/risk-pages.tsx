import type {
  RiskReportDetail,
  RiskReportView,
  RiskTaskView,
  Role,
  TradingRestrictionView,
} from '@barter/contracts';
import { Alert, Button, Card, Empty, Input, Table, Typography } from 'antd';
import { useEffect, useState, type HTMLAttributes } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  adminAfterSalesApi,
  loadBoundOperatorSession,
  type AdminAfterSalesApi,
} from '../../lib/after-sales-api';
import { ApiError, loadStoredSession } from '../../lib/api-client';
import { formatUtc } from '../review/review-queue-page';
import { ReauthDialog } from '../security/reauth-dialog';

type RiskClient = Pick<
  AdminAfterSalesApi,
  | 'listReports'
  | 'getReport'
  | 'listRiskTasks'
  | 'claimReport'
  | 'requestReportEvidence'
  | 'concludeReport'
  | 'getRestriction'
  | 'freezeUser'
  | 'unfreezeUser'
  | 'unpublishItem'
  | 'clearItemRisk'
  | 'pauseOrder'
  | 'clearOrderRisk'
  | 'onIdentityChange'
  | 'clearSensitiveState'
>;

function NamedTable(props: React.HTMLAttributes<HTMLTableElement> & { 'aria-label'?: string }) {
  return <table {...props} />;
}

export function RiskReportListPage({ client = adminAfterSalesApi }: { client?: RiskClient }) {
  const [items, setItems] = useState<RiskReportView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    void client
      .listReports(cursor ? { cursor } : {})
      .then((page) => {
        if (!active) return;
        setItems((previous) =>
          cursor
            ? [...(previous ?? []), ...page.items.filter((item) => !previous?.some((old) => old.id === item.id))]
            : page.items,
        );
        setNextCursor(page.nextCursor);
        setBusy(false);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : '加载失败');
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, cursor]);

  return (
    <main className="workspace-page risk-page">
      <Typography.Title level={1}>风险举报</Typography.Title>
      <p>
        <Link to="/risk/tasks">风险待办</Link> · <Link to="/risk/actions">单项处置</Link>
      </p>
      {error ? <Alert type="error" message={error} /> : null}
      {busy ? <p role="status">加载举报中</p> : null}
      {items?.length === 0 ? <Empty description="暂无举报" /> : null}
      {items && items.length > 0 ? (
        mobile ? (
          <ul className="mobile-review-list" aria-label="风险举报">
            {items.map((item) => (
              <li key={item.id}>
                <Card>
                  <Link to={`/risk/reports/${item.id}`}>查看举报 {item.id}</Link>
                  <p>
                    {item.status} · v{item.version}
                  </p>
                  <time>{formatUtc(item.createdAt)}</time>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Table
            rowKey="id"
            pagination={false}
            dataSource={items}
            components={{ table: (props: HTMLAttributes<HTMLTableElement>) => <NamedTable {...props} aria-label="风险举报" /> }}
            columns={[
              { title: '举报', render: (_, item) => <Link to={`/risk/reports/${item.id}`}>查看举报 {item.id}</Link> },
              { title: '状态', render: (_, item) => `${item.status} · v${item.version}` },
              { title: '创建', render: (_, item) => formatUtc(item.createdAt) },
            ]}
          />
        )
      ) : null}
      {nextCursor ? (
        <Button disabled={busy} onClick={() => setCursor(nextCursor)}>
          加载更多
        </Button>
      ) : null}
    </main>
  );
}

export function RiskReportDetailPage({
  client = adminAfterSalesApi,
  reportId: reportIdProp,
}: {
  client?: RiskClient;
  reportId?: string;
}) {
  const params = useParams();
  const reportId = reportIdProp ?? params.reportId ?? '';
  const [detail, setDetail] = useState<RiskReportDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    return client.onIdentityChange(() => {
      setDetail(null);
      setReason('');
      setError('');
    });
  }, [client]);

  useEffect(() => {
    if (!reportId) return;
    let active = true;
    setBusy(true);
    setDetail(null);
    void client
      .getReport(reportId)
      .then((value) => {
        if (active) {
          setDetail(value);
          setBusy(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '加载失败');
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, reportId]);

  const run = async (action: 'claim' | 'evidence' | 'conclude') => {
    if (!detail || !reason.trim()) {
      setError('请填写原因');
      return;
    }
    try {
      const input = { expectedVersion: detail.version, reason: reason.trim() };
      const key = `${action}:${detail.id}:v${detail.version}`;
      if (action === 'claim') await client.claimReport(detail.id, input, key);
      else if (action === 'evidence') await client.requestReportEvidence(detail.id, input, key);
      else await client.concludeReport(detail.id, { ...input, conclusion: 'ACTIONED' }, key);
      setDetail(await client.getReport(detail.id));
      setReason('');
      setError('');
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '操作失败');
    }
  };

  return (
    <main className="workspace-page risk-page">
      <Typography.Title level={1}>举报详情</Typography.Title>
      <Link to="/risk/reports">返回列表</Link>
      {busy ? <p role="status">加载举报详情中</p> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {detail ? (
        <Card title={detail.id}>
          <p>
            {detail.status} · v{detail.version} · {detail.reason}
          </p>
          <p>目标 {detail.targetType} / {detail.targetId}</p>
          <label>
            处理原因
            <Input.TextArea aria-label="举报处理原因" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </label>
          <Button onClick={() => void run('claim')}>认领</Button>
          <Button onClick={() => void run('evidence')}>要求补证</Button>
          <Button onClick={() => void run('conclude')}>记录结论</Button>
          <Alert type="info" showIcon message="关闭举报不会自动解除交易冻结、下架或订单阻塞。" />
        </Card>
      ) : null}
    </main>
  );
}

export function RiskTaskListPage({ client = adminAfterSalesApi }: { client?: RiskClient }) {
  const [items, setItems] = useState<RiskTaskView[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void client
      .listRiskTasks()
      .then((page) => {
        if (active) {
          setItems(page.items);
          setBusy(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : '加载失败');
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <main className="workspace-page risk-page">
      <Typography.Title level={1}>风险待办</Typography.Title>
      {busy ? <p role="status">加载待办中</p> : null}
      {error ? <Alert type="error" message={error} /> : null}
      {items?.length === 0 ? <Empty description="暂无待办" /> : null}
      {items && items.length > 0 ? (
        <ul aria-label="风险待办">
          {items.map((item) => (
            <li key={item.id}>
              {item.kind} · {item.status} · {item.description}
              {item.blockerId ? ` · blocker ${item.blockerId}` : ' · 无清除阻塞'}
              {item.orderId ? ` · 订单 ${item.orderId}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

type SensitiveRisk = 'freeze' | 'unfreeze' | 'pause' | 'unpublish' | 'clearItem' | 'clearOrder' | null;

export function RiskActionPage({
  client = adminAfterSalesApi,
  currentRoles,
  forceShowPrivileged,
}: {
  client?: RiskClient;
  currentRoles?: Role[];
  forceShowPrivileged?: boolean;
}) {
  const roles = currentRoles ?? loadStoredSession()?.user.roles ?? [];
  const [userId, setUserId] = useState('');
  const [itemId, setItemId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [blockerId, setBlockerId] = useState('');
  const [expectedVersion, setExpectedVersion] = useState(1);
  const [reason, setReason] = useState('');
  const [restriction, setRestriction] = useState<TradingRestrictionView | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<SensitiveRisk>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);
  const bound = loadBoundOperatorSession();
  const canRisk = roles.includes('SUPER_ADMIN') || roles.includes('REVIEWER');
  const isDesktop =
    forceShowPrivileged || (width >= 768 && bound?.capability === 'DESKTOP_PRIVILEGED');
  const mobileStopOk = width < 768 || bound?.capability === 'MOBILE_LIMITED' || bound?.capability === 'DESKTOP_PRIVILEGED';

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return client.onIdentityChange(() => {
      setReason('');
      setPending(null);
      setError('');
      setRestriction(null);
    });
  }, [client]);

  const loadRestriction = async () => {
    if (!userId) return;
    try {
      setRestriction(await client.getRestriction(userId));
      setError('');
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '查询失败');
    }
  };

  const run = async (action: Exclude<SensitiveRisk, null>, password: string) => {
    if (!reason.trim()) {
      setError('请填写原因');
      setPending(null);
      return;
    }
    setBusy(true);
    setError('');
    const input = { expectedVersion, reason: reason.trim() };
    const key = `${action}:${userId || itemId || orderId}:v${expectedVersion}`;
    try {
      if (action === 'freeze') await client.freezeUser(userId, input, password, key);
      else if (action === 'unfreeze') await client.unfreezeUser(userId, input, password, key);
      else if (action === 'pause') await client.pauseOrder(orderId, input, password, key);
      else if (action === 'unpublish') await client.unpublishItem(itemId, input, password, key);
      else if (action === 'clearItem') await client.clearItemRisk(itemId, input, password, key);
      else if (action === 'clearOrder') {
        if (!blockerId) throw new Error('清除订单风险需要 blockerId');
        await client.clearOrderRisk(orderId, { ...input, blockerId }, password, key);
      }
      setPending(null);
      setReason('');
      if (userId) setRestriction(await client.getRestriction(userId));
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : cause instanceof Error ? cause.message : '处置失败');
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  if (!canRisk) {
    return (
      <main className="workspace-page risk-page">
        <Typography.Title level={1}>单项处置</Typography.Title>
        <Alert type="warning" showIcon message="当前角色不能执行风险处置；客服不可冻结或资金执行。" />
      </main>
    );
  }

  return (
    <main className="workspace-page risk-page">
      <Typography.Title level={1}>单项处置</Typography.Title>
      <Alert type="info" showIcon message="仅支持单个用户冻结、单品下架、单笔订单暂停；不提供批量资金或自由账户输入批处理。" />
      <label>
        用户 ID
        <Input aria-label="用户 ID" value={userId} onChange={(e) => setUserId(e.target.value)} />
      </label>
      <Button onClick={() => void loadRestriction()}>查询交易限制</Button>
      {restriction ? (
        <p>
          限制状态 {restriction.status} · v{restriction.version} · {restriction.reason ?? '无原因'}
        </p>
      ) : null}
      <label>
        物品 ID
        <Input aria-label="物品 ID" value={itemId} onChange={(e) => setItemId(e.target.value)} />
      </label>
      <label>
        订单 ID
        <Input aria-label="订单 ID" value={orderId} onChange={(e) => setOrderId(e.target.value)} />
      </label>
      <label>
        blockerId（清除订单风险）
        <Input aria-label="blockerId" value={blockerId} onChange={(e) => setBlockerId(e.target.value)} />
      </label>
      <label>
        期望版本
        <Input
          aria-label="期望版本"
          type="number"
          value={expectedVersion}
          onChange={(e) => setExpectedVersion(Number(e.target.value) || 1)}
        />
      </label>
      <label>
        处置原因
        <Input.TextArea aria-label="处置原因" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </label>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div aria-label="移动紧急止损">
        <Button disabled={!mobileStopOk || !userId} onClick={() => setPending('freeze')}>
          冻结交易
        </Button>
        <Button disabled={!mobileStopOk || !itemId} onClick={() => setPending('unpublish')}>
          下架物品
        </Button>
        <Button disabled={!mobileStopOk || !orderId} onClick={() => setPending('pause')}>
          暂停订单
        </Button>
      </div>
      {isDesktop ? (
        <div aria-label="桌面恢复入口">
          <Button disabled={!userId} onClick={() => setPending('unfreeze')}>
            解冻交易
          </Button>
          <Button disabled={!itemId} onClick={() => setPending('clearItem')}>
            解除物品风险
          </Button>
          <Button disabled={!orderId || !blockerId} onClick={() => setPending('clearOrder')}>
            解除订单风险阻塞
          </Button>
        </div>
      ) : (
        <Alert type="warning" showIcon message="解冻与风险解除需桌面受信会话；390px 仅开放单项暂停/冻结等紧急止损。" />
      )}
      <ReauthDialog
        open={pending !== null}
        title="重新验证后执行风险命令"
        summary={`固定版本 v${expectedVersion} 与原因正文后签发一次性授权。`}
        busy={busy}
        error={error}
        onCancel={() => setPending(null)}
        onConfirm={(password) => {
          if (pending) void run(pending, password);
        }}
      />
    </main>
  );
}
