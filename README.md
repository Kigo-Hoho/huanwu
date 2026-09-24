# 以物换物 Phase 1

这个 npm workspaces 仓库实现了第一个可运行竖向切片：客户在 Taro 小程序中发布物品，审核员在响应式 React 工作台中审核，NestJS API 通过 PostgreSQL 持久化并记录审计日志。

## 环境要求

- Node.js 24.15.0 或更高版本
- npm（使用仓库内的 `package-lock.json` 执行 `npm ci`）
- Docker Engine 与 Docker Compose v2
- Playwright Chromium（首次运行可执行 `npx playwright install chromium`）

复制 `.env.example` 为 `.env`，并为本机设置至少 32 字符的 `JWT_SECRET` 和非空 `ADMIN_SEED_PASSWORD`。不要提交 `.env`、真实密码或密钥。

```powershell
Copy-Item .env.example .env
npm ci
docker compose up -d postgres
npm run db:reset
```

`npm run db:reset` 会删除当前 `DATABASE_URL` 中的业务数据、重新应用 migration，然后执行 seed；只能指向本地或专用测试库。非破坏性部署 migration 使用 `npm run db:migrate`，单独 seed 使用 `npm run db:seed`。

## Seed 账号

`npm run db:seed` 使用运行时的 `ADMIN_SEED_PASSWORD` 哈希后创建以下账号，仓库中不存在明文密码：

| 角色 | 邮箱 |
| --- | --- |
| 超级管理员 | `super-admin@barter.local` |
| 审核员 | `reviewer@barter.local` |
| 运营 | `operations@barter.local` |

seed 还会创建一个仅用于本地验证的客户身份。运营账号与客户身份严格分离。

## 启动开发环境

PostgreSQL 已启动且 migration/seed 完成后，在仓库根目录执行：

```powershell
npm run dev
```

该命令同时启动 API、H5 开发构建和管理端。也可分别运行：

- API：`npm run dev --workspace @barter/api`，默认 `http://localhost:3000/api`
- 管理端：`npm run dev --workspace @barter/admin`，默认 `http://localhost:5173`
- H5：`npm run dev:h5 --workspace @barter/miniapp`

微信小程序生产身份流程需要真实 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`。默认 provider 是真实的 `wechat`，不会回退到测试身份。

## 构建和质量门

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
```

`npm run build` 构建 shared contracts、Nest API、Vite 管理端和 WeChat 小程序目标。H5 可单独通过 `npm run build:h5 --workspace @barter/miniapp` 构建。

Prisma 7 的 datasource URL 位于 `apps/api/prisma.config.ts`，运行时 client 使用 PostgreSQL adapter；不要把 Prisma 6 的 `schema.prisma` datasource URL 或自动 seed 假设搬入本项目。CI/部署使用 `prisma migrate deploy`，seed 是显式独立步骤。

## 真实浏览器验收

E2E 会对专用数据库幂等地执行 migration/seed、以显式非生产 acceptance provider 构建 H5、用 `NODE_ENV=test` 启动 API 本地图片存储，并由 Playwright 启停 H5/API/Vite 进程。每次验收使用唯一物品标题，不依赖先前数据库状态。先在当前 shell 提供凭据；`E2E_REVIEWER_PASSWORD` 必须与 seed 时的 `ADMIN_SEED_PASSWORD` 相同，两者均不得写入仓库。

```powershell
$env:DATABASE_URL = 'postgresql://barter:barter_local_password@localhost:5432/barter'
$env:JWT_SECRET = '<choose-at-least-32-characters>'
$env:ADMIN_SEED_PASSWORD = '<choose-a-local-test-password>'
$env:E2E_REVIEWER_PASSWORD = $env:ADMIN_SEED_PASSWORD
npm run e2e
```

验收使用真实 API、PostgreSQL、multipart 图片上传、审核事务与审计日志；不 mock 业务后端。测试身份只在 `TARO_APP_IDENTITY_PROVIDER=acceptance`、`TARO_APP_ENVIRONMENT=acceptance` 且 H5 目标中生效。Webpack 使用 production 优化生成可静态服务的 bundle，但该 bundle 的应用环境仍明确是 `acceptance`。API 端还要求 `WECHAT_IDENTITY_PROVIDER=acceptance` 与 `NODE_ENV=test`。未显式声明 acceptance 应用环境的 production 构建会拒绝测试 provider。

## 本地图片存储边界

`LocalImageStorageAdapter` 仅允许 `NODE_ENV=development` 或 `NODE_ENV=test`，文件保存在忽略的 `.local/` 目录。它不是生产存储方案；生产环境会拒绝启动该 adapter，也不提供本地文件路由。切勿将 acceptance provider 或本地存储作为生产回退。

## Phase 1 范围

当前仅交付“客户创建/编辑/提交物品→有权限审核员通过或驳回→状态和审计记录持久化”。支持物换物与物品加小额差价的后续设计，但 Phase 1 不实现投物、订单、支付、物流或售后，也不支持纯现金购买。
