import type { Role } from '@barter/contracts';
import {
  Alert,
  Card,
  Descriptions,
  Image,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  ApiError,
  apiClient,
  type OperatorItem,
  type OperatorItemDetail,
  type ReviewApi,
} from '../../lib/api-client';
import { formatFen, formatUtc } from './review-queue-page';
import { ReviewActions } from './review-actions';

const { Title, Paragraph, Text } = Typography;
const conditions = { LIKE_NEW: '近新', GOOD: '良好', FAIR: '一般' } as const;
const auditActions: Record<string, string> = {
  ITEM_SUBMITTED: '提交审核',
  ITEM_APPROVED: '审核通过',
  ITEM_REJECTED: '审核驳回',
};

interface ItemReviewPageProps {
  client?: ReviewApi;
  currentRoles?: Role[];
  itemId?: string;
}

function renderApiError(error: unknown): string {
  return error instanceof ApiError
    ? `${error.code}：${error.message}`
    : '无法加载物品详情';
}

export function ItemReviewPage({
  client = apiClient,
  currentRoles = [],
  itemId: explicitItemId,
}: ItemReviewPageProps) {
  const params = useParams<{ itemId: string }>();
  const itemId = explicitItemId ?? params.itemId;
  const [item, setItem] = useState<OperatorItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!itemId) {
      setError('缺少物品编号');
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    client
      .getReviewItem(itemId)
      .then((result) => {
        if (active) setItem(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(renderApiError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, itemId]);

  function applyReviewed(updated: OperatorItem): void {
    setItem((current) => (current ? { ...current, ...updated } : current));
  }

  if (loading) {
    return (
      <main className="centered-state" aria-label="正在加载物品详情">
        <Spin size="large" />
      </main>
    );
  }
  if (error || !item) {
    return (
      <main className="workspace-page">
        <Alert type="error" showIcon message={error ?? '未找到物品'} />
      </main>
    );
  }

  return (
    <main className="workspace-page item-review-page">
      <Link to="/reviews">← 返回待审核列表</Link>
      <header className="item-heading">
        <div>
          <Text type="secondary">物品编号 {item.id}</Text>
          <Title level={1}>{item.title}</Title>
        </div>
        <Space wrap>
          <Tag color={item.status === 'PENDING_REVIEW' ? 'blue' : 'default'}>
            {item.status}
          </Tag>
          <Tag>v{item.version}</Tag>
        </Space>
      </header>

      <div className="detail-layout">
        <div className="item-evidence">
          <Card title="物品图片">
            <Image.PreviewGroup>
              <div className="item-image-grid">
                {item.imageUrls.map((url, index) => (
                  <Image
                    key={`${index}-${url}`}
                    src={url}
                    alt={`物品图片 ${index + 1}`}
                    className="item-image"
                  />
                ))}
              </div>
            </Image.PreviewGroup>
          </Card>

          <Card title="物品信息">
            <Descriptions column={{ xs: 1, sm: 2 }} bordered>
              <Descriptions.Item label="物主">
                {item.owner.displayName || item.owner.id}
              </Descriptions.Item>
              <Descriptions.Item label="参考价值">
                {formatFen(item.referenceValueFen)}
              </Descriptions.Item>
              <Descriptions.Item label="成色">
                {conditions[item.condition]}
              </Descriptions.Item>
              <Descriptions.Item label="提交时间">
                <time dateTime={item.updatedAt}>{formatUtc(item.updatedAt)}</time>
              </Descriptions.Item>
              <Descriptions.Item label="物品描述" span={2}>
                <Paragraph>{item.description}</Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="期望交换" span={2}>
                {item.wantedText || '未填写'}
              </Descriptions.Item>
              {item.rejectReason ? (
                <Descriptions.Item label="驳回原因" span={2}>
                  {item.rejectReason}
                </Descriptions.Item>
              ) : null}
            </Descriptions>
          </Card>

          <Card title="审核历史">
            <section aria-label="审核历史">
              {item.auditHistory.length === 0 ? (
                <Text type="secondary">暂无审核记录</Text>
              ) : (
                <Timeline
                  items={item.auditHistory.map((entry) => ({
                    children: (
                      <div>
                        <strong>{auditActions[entry.action] ?? entry.action}</strong>
                        <div>{entry.actor?.displayName || entry.actorId || '系统'}</div>
                        {entry.reason ? <div>原因：{entry.reason}</div> : null}
                        <time dateTime={entry.createdAt}>{formatUtc(entry.createdAt)}</time>
                      </div>
                    ),
                  }))}
                />
              )}
            </section>
          </Card>
        </div>

        <aside className="review-panel" aria-label="审核决策">
          <Card title="审核决策">
            <ReviewActions
              item={item}
              currentRoles={currentRoles}
              client={client}
              onReviewed={applyReviewed}
              onItemRefreshed={setItem}
            />
            {!currentRoles.some(
              (role) => role === 'REVIEWER' || role === 'SUPER_ADMIN',
            ) ? (
              <Text type="secondary">当前账号没有审核决策权限。</Text>
            ) : null}
          </Card>
        </aside>
      </div>
    </main>
  );
}
