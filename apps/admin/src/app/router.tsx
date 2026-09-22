import { Button, Layout, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom';

import { LoginPage } from '../features/auth/login-page';
import { ItemReviewPage } from '../features/review/item-review-page';
import { ReviewQueuePage } from '../features/review/review-queue-page';
import {
  ApiError,
  apiClient,
  loadStoredSession,
  type OperatorUser,
} from '../lib/api-client';

const { Header } = Layout;

function OperatorLayout({
  user,
  onLogout,
  children,
}: {
  user: OperatorUser;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <Typography.Text strong className="brand-name">
          以物换物 · 审核台
        </Typography.Text>
        <div className="operator-meta">
          <Typography.Text>{user.roles.join(' / ')}</Typography.Text>
          <Button
            onClick={() => {
              onLogout();
              navigate('/login', { replace: true });
            }}
          >
            退出登录
          </Button>
        </div>
      </Header>
      <div className="ant-layout-content">{children}</div>
    </Layout>
  );
}

function RouterContent() {
  const [session, setSession] = useState<OperatorUser | null | undefined>(
    undefined,
  );
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const stored = loadStoredSession();
    if (!stored) {
      setSession(null);
    } else {
      apiClient
        .bootstrapSession()
        .then((user) => {
          if (active) setSession(user);
        })
        .catch((error: unknown) => {
          if (!active) return;
          apiClient.logout();
          setBootstrapError(
            error instanceof ApiError
              ? error.status === 401
                ? '登录已过期，请重新登录'
                : `${error.code}：${error.message}`
              : '无法恢复登录状态，请重新登录',
          );
          setSession(null);
        });
    }
    const expire = () => setSession(null);
    window.addEventListener('barter:auth-expired', expire);
    return () => {
      active = false;
      window.removeEventListener('barter:auth-expired', expire);
    };
  }, []);

  if (session === undefined) {
    return (
      <main className="centered-state" aria-label="正在恢复登录状态">
        <Spin size="large" />
      </main>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          session ? (
            <Navigate to="/reviews" replace />
          ) : (
            <LoginPage
              bootstrapError={bootstrapError}
              onAuthenticated={(user) => {
                setBootstrapError(null);
                setSession(user);
              }}
            />
          )
        }
      />
      <Route
        path="/reviews"
        element={
          session ? (
            <OperatorLayout
              user={session}
              onLogout={() => {
                apiClient.logout();
                setSession(null);
              }}
            >
              <ReviewQueuePage />
            </OperatorLayout>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/reviews/:itemId"
        element={
          session ? (
            <OperatorLayout
              user={session}
              onLogout={() => {
                apiClient.logout();
                setSession(null);
              }}
            >
              <ItemReviewPage currentRoles={session.roles} />
            </OperatorLayout>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to={session ? '/reviews' : '/login'} replace />} />
    </Routes>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <RouterContent />
    </BrowserRouter>
  );
}
