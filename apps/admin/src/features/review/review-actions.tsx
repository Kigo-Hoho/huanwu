import type { Role } from '@barter/contracts';
import { Alert, Button, Form, Input, Space } from 'antd';
import { useState } from 'react';

import {
  ApiError,
  apiClient,
  type OperatorItem,
  type OperatorItemDetail,
  type ReviewApi,
  type ReviewItemInput,
} from '../../lib/api-client';

interface ReviewActionsProps {
  item: OperatorItem;
  currentRoles: Role[];
  client?: ReviewApi;
  onReviewed?: (item: OperatorItem) => void;
  onItemRefreshed?: (item: OperatorItemDetail) => void;
}

export function ReviewActions({
  item,
  currentRoles,
  client = apiClient,
  onReviewed,
  onItemRefreshed,
}: ReviewActionsProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<{ reason: string }>();
  const canReview = currentRoles.some(
    (role) => role === 'REVIEWER' || role === 'SUPER_ADMIN',
  );

  if (!canReview) return null;
  if (item.status !== 'PENDING_REVIEW') {
    return error ? (
      <section className="review-actions" aria-label="审核操作">
        <Alert type="error" showIcon message={error} />
      </section>
    ) : null;
  }

  async function decide(input: ReviewItemInput): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const updated = await client.reviewItem(item.id, input);
      onReviewed?.(updated);
      try {
        const refreshed = await client.getReviewItem(item.id);
        onItemRefreshed?.(refreshed);
      } catch (refreshError) {
        setError(
          `审核决定已保存，但最新审核详情加载失败：${
            refreshError instanceof ApiError
              ? `${refreshError.code}：${refreshError.message}`
              : '请稍后重新打开物品详情'
          }`,
        );
      }
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.status === 409 &&
        caught.code === 'ITEM_VERSION_CONFLICT'
      ) {
        try {
          const refreshed = await client.getReviewItem(item.id);
          onItemRefreshed?.(refreshed);
          setError('该物品已被其他审核员处理');
        } catch (refreshError) {
          setError(
            refreshError instanceof ApiError
              ? `${refreshError.code}：${refreshError.message}`
              : '刷新物品状态失败，请重新登录后查看',
          );
        }
      } else if (caught instanceof ApiError) {
        setError(`${caught.code}：${caught.message}`);
      } else {
        setError('审核请求失败，请稍后重试');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="review-actions" aria-label="审核操作">
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Button
        type="primary"
        size="large"
        loading={pending}
        disabled={pending}
        onClick={() =>
          void decide({ decision: 'APPROVE', expectedVersion: item.version })
        }
      >
        审核通过
      </Button>
      <Form
        form={form}
        layout="vertical"
        onFinish={({ reason }) =>
          void decide({
            decision: 'REJECT',
            expectedVersion: item.version,
            reason: reason.trim(),
          })
        }
      >
        <Form.Item
          name="reason"
          label="驳回原因"
          rules={[
            { required: true, message: '请输入驳回原因' },
            { min: 4, max: 300, message: '驳回原因需为 4–300 个字符' },
          ]}
        >
          <Input.TextArea
            rows={3}
            maxLength={300}
            showCount
            disabled={pending}
            placeholder="请清楚说明需要卖家修改的内容"
          />
        </Form.Item>
        <Space>
          <Button htmlType="submit" danger loading={pending} disabled={pending}>
            驳回物品
          </Button>
        </Space>
      </Form>
    </section>
  );
}
