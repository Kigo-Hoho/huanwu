# 以物换物 · 发布审核与投物协商

这个 npm workspaces 仓库实现发布审核和双用户投物协商：客户在 Taro 小程序发布物品、发现物品、协商交换，运营在响应式 React 工作台审核与只读查询提案，NestJS API 通过 PostgreSQL 持久化并记录审计日志。

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

- API：`npx --no-install cross-env NODE_ENV=development npm run dev --workspace @barter/api`，默认 `http://localhost:3000/api`
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

Phase 1 交付“客户创建/编辑/提交物品→有权限审核员通过或驳回→状态和审计记录持久化”。支持物换物与物品加小额差价的后续设计，但 Phase 1 不实现投物、订单、支付、物流或售后，也不支持纯现金购买。

## Phase 2 工作台

Phase 1 是已完成的发布审核基线；Phase 2 在此基础上新增找换、投物箱、轮流协商和限时占用。公开物品详情的“我要换”进入登录后的投物表单；用户选择自己的 1～5 件已上架物品，填写整数分差价（0～20000）及面交/快递运费估计。我的物品中的“投物箱”可切换发出/收到列表。详情展示全部历史方案；当前回应人可修改自己侧物品与条款、接受或拒绝，双方可取消待回应或已确认提案。

接受仅独占占用物品 72 小时，不创建订单、扣款或发货。待回应方案 7 天到期；取消/到期释放占用。网络失败重试保留相同命令键；版本或轮次冲突会刷新方案，用户需查看最新内容再操作。

运营网页导航“交换提案”提供 `/proposals` 列表及详情，电脑表格、手机卡片展示。OPERATIONS、REVIEWER、SUPER_ADMIN 都可通过独立 `GET /api/admin/proposals` 与 `GET /api/admin/proposals/:id` 查询完整历史，不能代用户修改、接受、拒绝或取消。读接口只读取持久化状态，期限清理由既有系统任务/用户请求处理。

测试 API 支持以下两个独立身份（仅 `NODE_ENV=test` 且显式 acceptance provider）；第二个客户在首次登录时由正常 AuthService 创建，无需给客户分配运营凭据。

| 浏览器身份码 | 测试微信标识 |
| --- | --- |
| `e2e-customer-code` | `local-seed-customer` |
| `e2e-customer-two-code` | `local-seed-customer-two` |

`e2e/two-customer-proposals.spec.ts` 创建两个隔离 BrowserContext，在页面加载前通过 `addInitScript` 设置 `globalThis.__BARTER_ACCEPTANCE_IDENTITY_CODE__`，由 H5 自己交换身份码并保存会话，不注入 bearer token。该变量只由显式 acceptance provider 读取；未注入时保留第一阶段的第一个客户，未知代码拒绝。真实 Taro provider 忽略此变量，微信失败不回退到测试账号。测试构建不得部署为生产应用。

浏览器验收先通过真实上传、创建、提交和审核 API 准备双方 ACTIVE 物品，然后在用户页面完成公开找换 → 发起方选择多件自己的物品 → 接收方替换自己的目标、修改差价与快递运费 → 发起方接受 → 匿名浏览确认全部当前物品不可投 → 接收方取消 → 全部恢复可投。保留旧目标可投及完整历史断言。第一阶段发布审核浏览器测试和 `e2e/admin-proposals.spec.ts` 的运营手机只读测试同时运行。

```powershell
# 使用上文同一组仅进程环境变量；完整套件会准备数据库和 H5 并自动启停服务。
npm run e2e
# 只运行双用户验收
npm run e2e -- two-customer-proposals.spec.ts
```

H5 使用 Taro 默认 hash 路由，直接进入页面用 `http://127.0.0.1:10086/#/pages/items/discover/index` 或 `/#/pages/items/mine/index`。测试由 Playwright 管理端口 3000、10086、5173，运行前需空闲。准备步骤只部署 migration 和更新 seed，不重置业务数据；每次使用唯一物品标题，并清理专用 `.local/e2e-item-images` 测试图片，因此必须使用专用测试库和图片目录。

CI 使用 PostgreSQL 17、Node.js 24.15.0 和 Chromium，顺序执行 lint、typecheck、test、build、verify、e2e 六项检查；浏览器失败保留 Playwright trace 七天。CI 凭据仅用于该临时测试服务。

## Phase 3 原子交接要求

Phase 2 的 CONFIRMED 表示最新方案的所有 2～6 件物品被独占占用 72 小时；它不是订单，现阶段没有订单转换、支付、物流、聊天或售后接口。取消与到期仍由同一提案转换服务原子释放，并保留历史报价与审计。

第三阶段的订单转换必须在服务端占用期限内完成一个数据库事务：锁定并重读提案及按 ID 排序的物品，核验 CONFIRMED、当前修订与报价、参与者和未到期时间；逐条核验全部占用的 proposalId、proposalVersionId 与当前完整快照一致；创建唯一对应订单并原子交接全部占用，同时写幂等结果及不可变审计。与取消、到期扫描及其他接受竞争必须通过同一锁顺序和状态前置条件裁决；失败整笔回滚，不得先释放再异步建单形成可被其他提案抢占的窗口。还需在第三阶段明确转换后提案状态及过期任务边界，补充转换/取消/到期竞争、重复命令和审计失败回滚测试。
