import { Alert, Card, Empty, Image, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState, type HTMLAttributes } from 'react';
import { Link } from 'react-router-dom';

import {
  ApiError,
  apiClient,
  type OperatorItem,
  type ReviewApi,
} from '../../lib/api-client';

const { Title, Text } = Typography;

export function formatFen(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

export function formatUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const update = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return mobile;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? `${error.code}：${error.message}`
    : '无法加载待审核物品';
}

const columns: ColumnsType<OperatorItem> = [
  {
    title: '图片',
    key: 'image',
    width: 88,
    render: (_, item) => (
      <Image
        src={item.imageUrls[0]}
        alt={`${item.title}缩略图`}
        width={56}
        height={56}
        preview={false}
        className="queue-thumbnail"
      />
    ),
  },
  {
    title: '标题',
    dataIndex: 'title',
    key: 'title',
    render: (title: string, item) => <Link to={`/reviews/${item.id}`}>{title}</Link>,
  },
  {
    title: '物主',
    key: 'owner',
    render: (_, item) => item.owner.displayName || item.owner.id,
  },
  {
    title: '参考价值',
    dataIndex: 'referenceValueFen',
    key: 'referenceValueFen',
    render: formatFen,
  },
  {
    title: '提交时间',
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    render: (value: string) => <time dateTime={value}>{formatUtc(value)}</time>,
  },
  {
    title: '版本',
    dataIndex: 'version',
    key: 'version',
    render: (value: number) => <Tag>v{value}</Tag>,
  },
];

function NamedTable(props: HTMLAttributes<HTMLTableElement>) {
  return <table {...props} aria-label="待审核物品" />;
}

export function ReviewQueuePage({ client = apiClient }: { client?: ReviewApi }) {
  const [items, setItems] = useState<OperatorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setLoading(true);
    client
      .listPendingItems()
      .then((result) => {
        if (active) setItems(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <main className="workspace-page">
      <header className="page-heading">
        <div>
          <Text type="secondary">审核工作台</Text>
          <Title level={1}>待审核物品</Title>
        </div>
        <Tag color="blue">{items.length} 件待处理</Tag>
      </header>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {loading ? (
        <div className="centered-state" aria-label="正在加载">
          <Spin size="large" />
        </div>
      ) : items.length === 0 ? (
        <Empty description="暂无待审核物品" />
      ) : mobile ? (
        <ul className="mobile-review-list" aria-label="待审核物品">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <article className="review-card">
                  <Image
                    src={item.imageUrls[0]}
                    alt={`${item.title}缩略图`}
                    width={88}
                    height={88}
                    preview={false}
                    className="queue-thumbnail"
                  />
                  <div className="review-card-content">
                    <Link to={`/reviews/${item.id}`}>{item.title}</Link>
                    <Text>{item.owner.displayName || item.owner.id}</Text>
                    <strong>{formatFen(item.referenceValueFen)}</strong>
                    <time dateTime={item.updatedAt}>{formatUtc(item.updatedAt)}</time>
                    <Tag>v{item.version}</Tag>
                  </div>
                </article>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          pagination={false}
          components={{ table: NamedTable }}
        />
      )}
    </main>
  );
}
