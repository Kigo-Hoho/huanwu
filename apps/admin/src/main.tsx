import 'antd/dist/reset.css';
import './styles/responsive.css';

import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { AppRouter } from './app/router';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#176B5B' } }}>
      <AppRouter />
    </ConfigProvider>
  </React.StrictMode>,
);
