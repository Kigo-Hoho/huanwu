# 以物换物 · 发布审核、投物协商与测试订单履约

这个 npm workspaces 仓库实现发布审核、双用户投物协商和第三阶段受控测试订单：客户在 Taro 小程序发布、协商、履约，运营通过响应式 React 工作台审核和只读查询。NestJS API 通过 PostgreSQL 持久化并记录审计日志。支付与物流仍为显式模拟，不能用于真实资金试运营。

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

Prisma 7 的 datasource URL 位于 `apps/api/prisma.config.ts`，运行时 client 使用 PostgreSQL adapter。项目继续使用 Prisma 7 的 `schema.prisma`、SQL migration、`migrate dev --create-only`；通用官网页面已切至新版时，应查阅 [v7 migrate dev](https://www.prisma.io/docs/cli/v7/migrate/dev) 和 [v7 自定义数据库功能](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features)。不升级到 Prisma 8，不修改已应用迁移；generate 和 seed 均显式执行。API 和前端当前实际 runner 均为 Vitest，早期计划中的 Jest 是历史文字，并非本阶段更换工具的要求。

## 真实浏览器验收

`npm run e2e` 的整个生命周期由 `scripts/prepare-e2e.mjs` 管理，根目录不再使用不能回传子进程环境的 `pree2e`。配置实际位于 `e2e/playwright.config.ts`。入口使用 `DATABASE_URL` 的连接身份创建本次独占命名空间数据库，只在该库应用全部 migration 和 seed；源库仅用于只读前后比对。连接角色必须允许 CREATE DATABASE 和删除自己创建的数据库。API、H5 与运营进程关闭后才等待普通 DROP 完成并核对目录中不存在该库，禁止 FORCE。失败同样清理且保留失败退出码。每次图片目录独立，禁止指向用户图片。先在当前 shell 提供凭据；`E2E_REVIEWER_PASSWORD` 必须与 `ADMIN_SEED_PASSWORD` 相同，两者均不得写入仓库。

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

H5 使用 Taro 默认 hash 路由，直接进入页面用 `http://127.0.0.1:10086/#/pages/items/discover/index` 或 `/#/pages/items/mine/index`。测试由 Playwright 管理端口 3000、10086、5173，运行前需空闲。入口自动生成客户端并构建 API/H5，支持单独执行与 `-- 文件名.spec.ts` 参数转发。数据库不重置；所有验收写入只发生在当次创建的独立库，源库的迁移记录与全部 public 表行数应保持不变。

CI 使用 PostgreSQL 17、Node.js 24.15.0 和 Chromium，顺序执行 lint、typecheck、test、build、verify、e2e 六项检查；浏览器失败保留 Playwright trace 七天。CI 凭据仅用于该临时测试服务。

## Phase 3 原子交接要求

Phase 2 的 CONFIRMED 表示最新方案的所有 2～6 件物品被独占占用 72 小时；接受方案仍不自动建单。第三阶段通过独立“生成交换订单”动作原子交接占用，转换后原提案取消或到期不得释放订单物品。

订单转换在同一服务端事务核验提案、完整物品占用、期限和参与者，再创建唯一订单、交接占用并写幂等结果及不可变审计。完成时原物品变为 INACTIVE，原发布者不变，不自动重新上架；未交接且双方同意取消后，必须确认未决付款关闭和全额退款，才释放占用。

## Phase 3 测试履约与边界

规则 `phase3-test-v1`：双方各 1000 分保证金、服务费 0 分、差价沿用方案的 0～20000 分；快递资料和付款各 24 小时，双方共同履约 72 小时，每方收到后验收 72 小时。时间由服务端 UTC 裁决，等于截止即到期。运单登记或任何面交交接后不允许安全取消；未决取消禁止交接与结算。超时、物流异常或验收异议进入 ON_HOLD 并保持占用，第四阶段才处理异常、退货和运营资金授权。不会自动验收、罚扣或解锁。

模拟 provider 默认 disabled；仅 `NODE_ENV=development/test` 显式选择 `PAYMENT_PROVIDER=simulated`、`LOGISTICS_PROVIDER=simulated` 后可用。生产拒绝模拟及缺失的真实接入，真实微信、生产图片存储、支付资金路径和物流合作方仍待接入与验收。运营订单页只读、脱敏，不能代用户履约或处置资金。

地址采用 AES-256-GCM。运行环境提供 32 字节 Base64 `ADDRESS_ENCRYPTION_KEY_BASE64`、版本 `ADDRESS_ENCRYPTION_KEY_VERSION`，模拟签名另用独立 32 字节 `SIMULATED_INTEGRATION_SIGNING_KEY_BASE64`。E2E 每次运行内生成并在同次 API 启动／重启间复用，完成后释放；密钥仅交给 API，不进入 H5/管理端构建、日志、仓库或审计。长期环境需自行保管加密密钥和版本，不可在已有密文仍需读取时随意换钥。

验收 H5 必须同时显式设置 `TARO_APP_ENVIRONMENT=acceptance`、`TARO_APP_IDENTITY_PROVIDER=acceptance`、`TARO_APP_INTEGRATION_MODE=simulated` 且目标为 H5；页面还要求 API 的 simulation 标识。测试驱动仅提交自己的模拟支付／物流外部事实，不直接改订单数据库。Task 13 的七条浏览器流程保留原三条，并新增五换一快递含差价、未交接双边取消退款、无运单双方面交、390px 运营只读；整分支修复再增加真实 API 的跨身份命令／私有资料保护流程，最终共八条。前置帮助函数仅上传／发布／审核和确认提案；建单、付款、履约、取消与验收均从页面执行，双方使用隔离会话。

## Phase 3 本地完成记录（2026-10-07）

13 项实施任务及各自独立审查已完成。首次整分支审查在 `879c015` 的结论为 **With fixes**（Critical 0／Important 1／Minor 4）。首轮修复 `a028db1` 经独立复核解决 M3 安全诊断分类和 M4 部分初始化清理，但 I1／R1 身份证明关联仍未解决；用户随后明确授权额外窄修复 `daa7f27`。最终独立复核确认 I1／R1 已解决、无新增 Critical／Important、范围内未解决项为空。任务—提交—审查对照及历史失败见[第三阶段完成记录](docs/superpowers/plans/2026-10-02-barter-orders-fulfillment-implementation.md#2026-10-07-本地完成记录)。这里完成的是受控模拟闭环。

最终行为提交 `daa7f27` 上，六项质量门分别独立执行：

| 命令 | 退出码／结果 |
| --- | --- |
| `npm run lint` | 0 |
| `npm run typecheck` | 0 |
| `npm test` | 0，610 项通过 |
| `npm run build` | 0，保留下述警告 |
| `npm run verify` | 0，独立重复 610 项测试并完成构建 |
| `npm run e2e` | 0，8／8 通过，拥有的测试库销毁和源库保护证明通过 |

610 = root 12 + admin 29 + 旧 API 137 + Phase 3 API 259 + miniapp 128 + contracts 45。原 Task 13 的 569 项／7 条浏览器流程是修复前历史结果。增量升级专项 1／1 在独占库保留原六件租约及不可变历史，已包含于 Phase 3 测试总数，不能重复加计。本机 Docker／WSL2 不可用，实际验证使用官方 PostgreSQL 17.11／UTC，未替换为 SQLite。GitHub CI 已配置但本分支未远程运行；分支尚未推送、开 PR、合并或部署，集成方式等待用户选择。

保留的关注项：首次 verify 的 `OrderApi is not a constructor` 与额外修复验证中的 undefined `MyItemsPage` 是两个不同且原因未确认的加载事件；后续通过只证明未复发，不能声称已修好或同一根因。构建仍有管理端 1,458.98 kB 超过 1300 kB、Taro vendor 671 KiB 超过 244 KiB 及 NoAsyncChunks 警告，浏览器仍有 Ant Design React 兼容与 Descriptions 布局警告。安全诊断分类已修复，但旧的图片清理 throwing-finally 在同时失败时仍可能替换更早的诊断；数据库清理及保护证明继续执行且失败仍致命。普通 DROP 的 26.42 秒计时证实了一次清理测试生命周期重叠，已修正该测试准备／销毁等待；测试和 hook 时限未改，未证明 Windows／IO 性能根因。未来复发须诊断，不能循环重试直到通过。

最终只读证明显示保留源库 `barter` 仍只有原两次 migration、12 张 public 表行数不变、遗留 Phase 3 测试库为零。这是迁移／计数／目录证据，不是逐字节备份。源库**尚未升级为可运行的 Phase 3 演示／业务库**；新迁移只在独占的新建／增量升级测试库验证。未来部署必须明确选择并备份目标库，应用已提交的 migration 和运行配置后再启动服务；质量门不会静默升级保留源库。运行只需仓库已提交的入口与自行配置的环境，不依赖私有临时辅助程序。含测试凭据／地址的日志和 trace 私下保留，不提交或上传。

真实微信身份、生产图片存储、支付资金路径、物流合作方、地址密钥管理、第四阶段异常／售后和第五阶段上线质量门仍是正式运营依赖。
