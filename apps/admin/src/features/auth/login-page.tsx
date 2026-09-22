import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';

import {
  ApiError,
  apiClient,
  type AdminApiClient,
  type OperatorUser,
} from '../../lib/api-client';

const { Title, Paragraph } = Typography;

interface LoginPageProps {
  client?: AdminApiClient;
  onAuthenticated: (user: OperatorUser) => void;
}

export function LoginPage({ client = apiClient, onAuthenticated }: LoginPageProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(values: { email: string; password: string }) {
    setSubmitting(true);
    setError(null);
    try {
      const session = await client.login(values.email, values.password);
      onAuthenticated(session.user);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? `${caught.code}：${caught.message}`
          : '登录失败，请稍后重试',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <Card className="login-card">
        <Title level={1}>运营审核登录</Title>
        <Paragraph type="secondary">请使用运营后台账号登录。</Paragraph>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Form layout="vertical" onFinish={(values) => void submit(values)}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '请输入有效邮箱' },
            ]}
          >
            <Input autoComplete="username" inputMode="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={submitting}
            aria-label="登录"
            block
          >
            登录
          </Button>
        </Form>
      </Card>
    </main>
  );
}
