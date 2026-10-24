import { CaseStatusSchema, type AdminCaseView, type CaseStatus } from '@barter/contracts';
import { Alert, Button, Card, Empty, Table, Typography } from 'antd';
import { useEffect, useState, type HTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { adminAfterSalesApi, type AdminAfterSalesApi, type AdminCaseQuery } from '../../lib/after-sales-api';
import { formatUtc } from '../review/review-queue-page';

export const caseStatusLabels: Record<CaseStatus, string> = {
  OPEN: '已受理',
  AWAITING_RESPONSE: '待补证',
  UNDER_REVIEW: '审核中',
  AWAITING_AGREEMENT: '待确认方案',
  EXECUTING: '执行中',
  RESOLVED: '已结案',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};

const detailLink = (item: AdminCaseView) => <Link to={`/after-sales/${item.id}`}>查看工单 {item.id}</Link>;
function NamedTable(props: HTMLAttributes<HTMLTableElement>) {
  return <table {...props} aria-label="售后工单" />;
}

export function CaseListPage({ client = adminAfterSalesApi }: { client?: Pick<AdminAfterSalesApi, 'listCases'> }) {
  const [query, setQuery] = useState<AdminCaseQuery>({});
  const [retry, setRetry] = useState(0);
  const [items, setItems] = useState<AdminCaseView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
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
    if (!query.cursor) {
      setItems(null);
      setNextCursor(null);
    }
    void client
      .listCases(query)
      .then((page) => {
        if (!active) return;
        setItems((previous) =>
          query.cursor
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
  }, [client, query, retry]);

  return (
    <main className="workspace-page after-sales-page">
      <Typography.Title level={1}>售后工单</Typography.Title>
      <p>平台处理时间线不伪装用户；资金动作仅模拟且需桌面双人审批</p>
      <label className="order-filter">
        工单状态
        <select
          aria-label="工单状态"
          value={query.status ?? ''}
          onChange={(event) => {
            setQuery(event.target.value ? { status: event.target.value as CaseStatus } : {});
          }}
        >
          <option value="">全部状态</option>
          {CaseStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {caseStatusLabels[status]}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div>
          <Alert type="error" message={error} />
          <Button aria-label="重试" onClick={() => setRetry((value) => value + 1)}>
            重试
          </Button>
        </div>
      )}
      {busy && <p role="status">加载售后工单中</p>}
      {items?.length === 0 ? (
        <Empty description="暂无售后工单" />
      ) : items &&
        (mobile ? (
          <ul className="mobile-review-list" aria-label="售后工单">
            {items.map((item) => (
              <li key={item.id}>
                <Card>
                  {detailLink(item)}
                  <p>
                    {caseStatusLabels[item.status]} · v{item.version}
                  </p>
                  <p>订单 {item.orderId}</p>
                  <time>{formatUtc(item.createdAt)}</time>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Table
            rowKey="id"
            dataSource={items}
            pagination={false}
            components={{ table: NamedTable }}
            columns={[
              { title: '工单', render: (_, item) => detailLink(item) },
              { title: '状态', render: (_, item) => `${caseStatusLabels[item.status]} · v${item.version}` },
              { title: '订单', dataIndex: 'orderId' },
              { title: '创建时间', render: (_, item) => formatUtc(item.createdAt) },
            ]}
          />
        ))}
      {nextCursor && !error && (
        <Button disabled={busy} onClick={() => setQuery({ ...(query.status ? { status: query.status } : {}), cursor: nextCursor })}>
          加载更多
        </Button>
      )}
    </main>
  );
}
