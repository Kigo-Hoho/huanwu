import { Alert, Button, Input, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';

export type ReauthDialogProps = {
  open: boolean;
  title: string;
  summary: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (password: string) => void | Promise<void>;
};

export function ReauthDialog({
  open,
  title,
  summary,
  confirmLabel = '重新验证并执行',
  busy = false,
  error = '',
  onCancel,
  onConfirm,
}: ReauthDialogProps) {
  const [password, setPassword] = useState('');
  const passwordRef = useRef('');

  useEffect(() => {
    if (!open) {
      passwordRef.current = '';
      setPassword('');
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title={title}
      onCancel={() => {
        passwordRef.current = '';
        setPassword('');
        onCancel();
      }}
      footer={null}
      destroyOnClose
      maskClosable={!busy}
    >
      <p>{summary}</p>
      <Alert type="warning" showIcon message="密码仅用于本次重新验证请求，不会写入本地存储、日志或幂等正文。" />
      <label>
        管理员密码
        <Input.Password
          aria-label="管理员密码"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            passwordRef.current = next;
            setPassword(next);
          }}
        />
      </label>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div className="reauth-actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="primary"
          disabled={busy || !password}
          loading={busy}
          onClick={() => {
            const value = passwordRef.current;
            passwordRef.current = '';
            setPassword('');
            void onConfirm(value);
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
