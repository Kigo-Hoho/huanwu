import type { OperatorDeviceView, OperatorSessionView } from '@barter/contracts';
import { Alert, Button, Card, Empty, Input, Table, Typography } from 'antd';
import { useEffect, useState, type HTMLAttributes } from 'react';
import { adminAfterSalesApi, type OperatorSecurityApi } from '../../lib/after-sales-api';
import { ApiError } from '../../lib/api-client';
import { formatUtc } from '../review/review-queue-page';

function NamedTable(props: HTMLAttributes<HTMLTableElement>) {
  return <table {...props} aria-label="运营设备" />;
}

export function DevicePage({
  client = adminAfterSalesApi,
}: {
  client?: Pick<
    OperatorSecurityApi,
    'listDevices' | 'currentDevice' | 'listSessions' | 'revokeSession' | 'securityLogin' | 'clearSensitiveState' | 'getBoundSession'
  > & { onIdentityChange?: (listener: () => void) => () => void };
}) {
  const [devices, setDevices] = useState<OperatorDeviceView[] | null>(null);
  const [sessions, setSessions] = useState<OperatorSessionView[] | null>(null);
  const [current, setCurrent] = useState<OperatorDeviceView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revokeReason, setRevokeReason] = useState('主动撤销会话');

  const reload = async () => {
    setBusy(true);
    setError('');
    try {
      const [devicePage, sessionPage] = await Promise.all([client.listDevices(), client.listSessions()]);
      setDevices(devicePage.items);
      setSessions(sessionPage.items);
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    return client.onIdentityChange?.(() => {
      setDevices(null);
      setSessions(null);
      setCurrent(null);
      setPassword('');
      setError('');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const enroll = async () => {
    setError('');
    try {
      const device = await client.currentDevice();
      setCurrent(device);
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '登记失败');
    }
  };

  const loginBound = async () => {
    setError('');
    const pwd = password;
    setPassword('');
    try {
      await client.securityLogin(email, pwd);
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '绑定登录失败');
    }
  };

  const revoke = async (session: OperatorSessionView) => {
    try {
      await client.revokeSession(
        session.id,
        { expectedVersion: session.version, reason: revokeReason.trim() || '主动撤销会话' },
        `revoke-session:${session.id}:v${session.version}`,
      );
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code}：${cause.message}` : '撤销失败');
    }
  };

  return (
    <main className="workspace-page security-page">
      <Typography.Title level={1}>运营设备与会话</Typography.Title>
      <Alert
        type="warning"
        showIcon
        message="设备登记只生成待批准记录，不会自动批准桌面能力。首次批准须走受控服务器 bootstrap / CLI，不能网页自批。"
      />
      <section aria-label="绑定运营会话登录">
        <label>
          运营邮箱
          <Input aria-label="运营邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          运营密码
          <Input.Password
            aria-label="运营密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <Button type="primary" onClick={() => void loginBound()}>
          绑定设备登录
        </Button>
      </section>
      <Button onClick={() => void enroll()}>登记当前设备（待批准）</Button>
      {current ? (
        <Card title="刚登记设备">
          <p>
            {current.id} · {current.status} · {current.capability} · v{current.version}
          </p>
          {current.status === 'PENDING' ? (
            <Alert type="info" showIcon message="状态为 PENDING：受控 bootstrap 批准前不能取得 DESKTOP_PRIVILEGED，前端不会自动批准。" />
          ) : null}
        </Card>
      ) : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {busy ? <p role="status">加载设备中</p> : null}
      {devices?.length === 0 ? <Empty description="暂无设备" /> : null}
      {devices && devices.length > 0 ? (
        <Table
          rowKey="id"
          pagination={false}
          dataSource={devices}
          components={{ table: NamedTable }}
          columns={[
            { title: '设备', dataIndex: 'id' },
            { title: '状态', render: (_, item) => `${item.status} · ${item.capability}` },
            { title: '版本', dataIndex: 'version' },
            { title: '创建', render: (_, item) => formatUtc(item.createdAt) },
          ]}
        />
      ) : null}
      <Typography.Title level={2}>本人会话</Typography.Title>
      <label>
        撤销原因
        <Input aria-label="撤销原因" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
      </label>
      {sessions?.length === 0 ? <Empty description="暂无会话" /> : null}
      {sessions && sessions.length > 0 ? (
        <ul aria-label="运营会话">
          {sessions.map((session) => (
            <li key={session.id}>
              {session.id} · {session.capability} · v{session.version} · 到期 {formatUtc(session.expiresAt)}
              <Button danger size="small" onClick={() => void revoke(session)}>
                撤销会话
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
