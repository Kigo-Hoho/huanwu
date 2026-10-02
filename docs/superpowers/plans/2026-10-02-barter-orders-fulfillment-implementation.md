# 第三阶段双向订单与履约 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认交换方案原子转换为订单，以显式模拟支付／物流完成双方资金、发货或面交、验收、取消退款和结算闭环。

**Architecture:** 沿用同一 NestJS API、共享 Zod 契约和 PostgreSQL；提案通过公开事务接口向订单交接占用。订单状态、审计、幂等及 outbox 同事务，外部调用在提交后执行，可信结果经独立事务核对；普通用户和运营身份严格隔离。

**Tech Stack:** Node.js >=24.15.0、npm workspaces、TypeScript、Taro 4／React、React／Vite／Ant Design、NestJS、PostgreSQL 17、Prisma ORM 7、Zod；沿用当前基线的 Vitest、Supertest、Testing Library 和 Playwright，不在本阶段更换测试 runner；地址加密使用 Node 原生 crypto。

**Spec:** `docs/superpowers/specs/2026-10-02-barter-orders-fulfillment-design.md`。

**Baseline:** `main@1859fa4`，规格提交 `1bf9765`，分支 `codex/phase3-orders-fulfillment`。本计划已获用户确认并执行；沿用逐任务新实现代理及新审查代理方式。

## Global Constraints

- 全部金额为 CNY 整数分，API 时间为 UTC ISO 8601；差价固定取确认方案的 0～20000 分与付款方向。
- 测试规则版本 `phase3-test-v1`：每人保证金 1000 分、平台服务费 0 分；资料 24 小时、支付 24 小时、双方共同履约 72 小时、每方验收 72 小时。
- 同一提案只建一个订单，2～6 件占用原位交接；CONVERTED 提案的取消和到期不能影响订单，完成物品变 INACTIVE，不自动重新上架或转移原发布记录 ownerId。
- 用户写命令要求纯 CUSTOMER 会话、Idempotency-Key 和 expectedVersion；带任一运营角色的混合会话也拒绝；非参与者统一 404。运营仅独立只读、脱敏查询。
- 同键同内容重放原成功结果，同键不同内容／资源返回 IDEMPOTENCY_CONFLICT；先核验权限与重放，再裁决新命令期限。
- 锁顺序：需要时提案 → 订单 → 按 ID 排序物品／占用 → 资金等关联行；等待锁后重验时间，`now >= deadline` 到期。
- 状态、占用、物品、资金记录、outbox、幂等和不可删除审计必须同事务；地址、电话和临时付款凭据不进入通用响应缓存或审计。
- 外部网络不在业务事务内；结果 unknown 必须核对，不能换业务号重扣、重复退款或重复结算。数据库回滚不能声称撤销已发生的外部资金结果。
- 无交接取消需双方同意，资料／支付超时可自动取消；未决取消阻止发货和结算；任何运单登记或面交交接后均不得安全解锁取消。
- 发货／验收超时、物流异常或验收异议进入 ON_HOLD；不自动验收、罚扣保证金、退款、恢复履约或释放占用。完整售后与运营干预留给第四阶段。
- 模拟支付／物流仅 development／test 且显式 provider；生产明确拒绝模拟和缺失配置，不写假生产接入，不提交真实凭据，不替换 PostgreSQL。
- 保留第一、第二阶段全部测试和行为；不实现聊天、纯现金购买、退货裁决或独立运营小程序。
- 每项按 RED → GREEN → 新代理独立审查 → 独立提交推进；13 项顺序执行，不并行修改依赖模块。审查发现问题回到原实现代理修正，最后再作整分支独立审查。

## Review Focus

- 订单占用超过原提案 72 小时仍不可投；取消旧提案不能解锁，完成原物品不能再次成交：任务 2、3、9、10。
- 用户换成混合运营角色、跨资源重用键或付款参数不明时，不能借重放／查询读到其他人的资料或执行另一笔付款：任务 3、4、7。
- 外部成功后进程退出或审计失败，只能核对同业务号，资金不得重复执行：任务 5、7、9。
- 请求等锁跨过截止时间、定时任务延迟或跨阶段残留旧期限，均不能错误推进／解除占用：任务 3、6、8、9、10。
- 前端慢刷新、网络结果未知或有效取消未回应，不能覆盖新状态、换幂等键重试或继续发货／结算：任务 6、11、13。

---

## 文件结构与边界

- `packages/contracts/src/orders.ts`：跨应用 schema、状态、命令输入及无敏感资料的视图；`orders.test.ts` 验证公开契约。
- `apps/api/src/common/clock.ts`、`clock.module.ts`：`CLOCK`、`Clock.now(): Date`、默认 SystemClock；测试注入 MutableClock。
- `apps/api/src/reservations/reservation-policy.ts`、`reservations.service.ts`、`reservations.module.ts`：所有者可用性、排序加锁、集合核验、交接／释放。
- `apps/api/src/proposals/proposal-order-handoff.service.ts`：仅提案模块拥有确认版本转换，不导出其私有状态实现。
- `apps/api/src/orders/`：`order-policy.ts`、`order-rules.ts`、`order.mapper.ts`、`order-commands.service.ts`、`orders.service.ts`、`orders.controller.ts`、`orders.module.ts`；其余服务按资料、取消、验收、到期分文件。
- `apps/api/src/payments/`：`payment.port.ts`、`payments.service.ts`、`payment-events.service.ts`、`payment-outbox.handler.ts`、`settlement.service.ts`、`payments.module.ts`。
- `apps/api/src/logistics/`：`logistics.port.ts`、`shipments.service.ts`、`logistics-events.service.ts`、`logistics-outbox.handler.ts`、`logistics.module.ts`。
- `apps/api/src/integrations/`：`integration.types.ts`、`integration-config.ts`、`outbox.service.ts`、`outbox.worker.ts`、`outbox-handler.registry.ts`、`simulated-payment.adapter.ts`、`simulated-logistics.adapter.ts`、`simulated-provider.store.ts`、`testing-integrations.controller.ts`、`integrations.module.ts`。
- `apps/api/test/phase3/`：新阶段真实 PostgreSQL 测试；`support/database-global-setup.ts`、`database-fixtures.ts`、`order-harness.ts` 管理独立测试库、双身份和时钟，不修改现有业务库。
- `apps/miniapp/src/pages/orders/`：列表、详情、资料／付款／发货操作组件；`features/orders/order-api.ts` 隔离传输和逻辑命令键。
- `apps/admin/src/features/orders/`：运营只读列表、详情；沿用现有响应式布局与登录。
- `e2e/`：在原三个流程之外加入快递订单、未交接取消、面交和运营订单手机查询；公共准备放 `support/orders.ts`。

## 固定接口与持久化决定

下列名称供相邻任务衔接，不能单任务私自改名。新增类型首次定义所在任务为 1、2、3、5；后续接口只引用它们。

- `OrderStatus` 使用规格中的十个英文状态；`OrderSide=INITIATOR|RECIPIENT`，`PaymentPurpose=DEPOSIT|DIFFERENCE`。
- `OrderRulesSnapshot` 保存 `version, depositFen, feeFen, detailsHours, paymentHours, fulfillmentHours, inspectionHours`。默认值严格对应 Global Constraints。
- `OrderView` 保存 `id, proposalId, proposalVersionId, initiatorId, recipientId, status, version, rules, terms, items, parties, cancellation, holdReason, simulation, detailsDeadline, paymentDeadline, fulfillmentDeadline, createdAt, updatedAt`。items 为完整快照和 side；parties 有 `side,userId,addressReady,payments,outgoingShipment,incomingDeliveredAt,acceptanceDeadline,acceptedAt`，可空时间必须为 null。没有完整地址、电话或 checkout 凭据。
- `OrderCommandResult={order:OrderView,paymentIntentId?:string}`；`OrderListView={items:OrderView[],nextCursor:string|null}`。所有写命令返回该脱敏结果；创建 201，普通成功 200，付款待执行 202。
- `OrderCommandInput={expectedVersion:number}`；资料增加 `recipientName,phone,region,detail`，付款仅增加 purpose，运单仅增加 carrier／trackingNumber，异议／取消增加 reason，取消回应／撤回增加 cancellationId，回应另有 decision=AGREE|REJECT。
- `OrderAddressView` 为完整资料的独立授权读取；`CheckoutView` 区分 PENDING 与 READY，READY 的 provider／params 仅付款本人可读，不在幂等响应中。
- `OrderTx=Prisma.TransactionClient`；`LockedOrder=Prisma.OrderGetPayload<{include:typeof orderInclude}>`，orderInclude 和投影 mapOrder 在任务 3 定义。
- `ProviderOperation={businessNo,orderId,kind,payload}`，kind 为 CREATE_PAYMENT、CLOSE_PAYMENT、REFUND_PAYMENT、SETTLE_DIFFERENCE、VERIFY_SHIPMENT、QUERY_SHIPMENT；payload 不含地址明文或付款凭据。
- `ProviderResult` 的 status=PENDING|SUCCESS|FAILURE|UNKNOWN；查询明确不存在以 FAILURE／reason=NOT_FOUND 表达，不把 UNKNOWN 当成不存在。SUCCESS 具有唯一外部编号和可信事件，FAILURE 不直接证明资金已安全退款。
- `VerifiedIntegrationEvent` 是按 kind 区分的联合类型：共同字段为 provider／eventId／kind／businessNo／occurredAt；资金事件必须有 externalTransactionId／amountFen／currency，物流事件必须有 shipmentId／progress。由适配器验签或受信 worker 核对产生，不接受客户随意构造。
- `FinancialEntryType=PAYMENT|REFUND|DIFFERENCE_SETTLEMENT`；保证金正常返还和取消全额退款都使用 REFUND，同一 intent 不能各退一次。差价退款与差价结算互斥，由持锁状态机核验。
- 环境变量固定为 PAYMENT_PROVIDER／LOGISTICS_PROVIDER（disabled 或 simulated）、SIMULATED_INTEGRATION_SIGNING_KEY_BASE64、ADDRESS_ENCRYPTION_KEY_BASE64／ADDRESS_ENCRYPTION_KEY_VERSION；默认 disabled。模拟签名密钥运行时生成且只供 API，不能进入前端 bundle；服务重启测试须复用同一次测试的密钥。
- 前端 TARO_APP_INTEGRATION_MODE=disabled|simulated 定义常量 __INTEGRATION_MODE__，默认 disabled；simulated 只允许显式 development／acceptance 构建，acceptance 另须 H5、既有 TARO_APP_IDENTITY_PROVIDER=acceptance 与 TARO_APP_ENVIRONMENT=acceptance。生产选择 simulated 构建失败，API simulation=false 时也不显示驱动。

数据库模型按规格建立；额外固定以下键：Order.proposalId 唯一；OrderPartyProgress 与 OrderAddress 各 `(orderId,side)` 唯一；PaymentIntent `(orderId,side,purpose)` 与 businessNo 唯一；Shipment `(orderId,side)` 和 `(carrier,trackingNumber)` 唯一；IntegrationEvent `(provider,eventId)` 唯一；FinancialEntry `(intentId,entryType)` 唯一，对 provider／externalTransactionId／entryType 防重；OutboxCommand.businessNo 唯一。支付及资金确认金额必须大于零，规则／条款金额非负；双方 ID 不同及占用互斥由 CHECK 保护。

OrderCancellation 保存 REQUESTED／AGREED／REJECTED／WITHDRAWN／EXPIRED，SQL 部分唯一索引保证每订单至多一份 REQUESTED。IntegrationEvent 的原始可信事件行和处理状态分开：不可变正文，处理结果在单独 IntegrationEventReceipt；历史资金记录不可变，不能为了重试修改成功记录。

订单的规则、双方、来源、交易条款和快照列加不可变保护，OrderItemSnapshot、FinancialEntry、ShipmentEvent 拒绝 UPDATE／DELETE；Order.status／version／进度和 outbox 租约按事务更新。测试适配器用 SimulatedProviderOperation 保存其独立外部结果，不调用订单事务客户端；服务重启不能抹去模拟支付成功事实。

### 环境和工具兼容性

已核对 [Prisma CLI v7 migrate dev](https://www.prisma.io/docs/cli/v7/migrate/dev) 和本地安装版 `prisma migrate dev --help`，保留 `schema.prisma`、`migration.sql`、`--create-only`，generate／seed 显式执行。通用 ORM 文档已指向 ORM 8，不能照搬其 contract／TypeScript migration 命令；自定义触发器按 [Prisma ORM v7 文档](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features) 编辑未应用的 SQL 迁移。禁止修改已应用的前两阶段迁移或接受重置现有库的提示。

地址采用 AES-256-GCM：32 字节环境密钥、每次随机 12 字节 nonce、固定 16 字节认证 tag；AAD 绑定 orderId／side／资料版本。严格检查格式、tag 长度及解密认证失败，参考 [Node.js 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatedecipherivalgorithm-key-iv-options)。测试密钥运行时产生，示例仅占位。

执行前检查 Node／npm、工作区、端口和 PostgreSQL。Docker 若仍因 WSL2 不可用，不擅自改系统设置、重置 Docker、删除数据或替换数据库；先完成不依赖数据库的任务并记录哪些 PostgreSQL RED／GREEN 尚未执行，不能把连接错误当作功能 RED。外部 CI 验证需要取得相应推送权限，不能声称本地通过。

## Task 1: 共享订单契约、规则及纯状态策略

**Files:** Create `packages/contracts/src/orders.ts`、`orders.test.ts`；Modify `index.ts`、`errors.ts`、`proposals.ts`；Create `apps/api/src/orders/order-rules.ts`、`order-policy.ts`、`order-policy.spec.ts`、`apps/api/src/common/clock.ts`、`clock.module.ts`。

**Interfaces:** consumes ProposalTerms／ProposalItemSnapshot；produces 本节 OrderView／OrderCommandResult／OrderListView 及对应 Zod schema、OrderCommandSchema、OrderAddressSchema、OrderPaymentSchema、OrderShipmentSchema、OrderIssueSchema、OrderCancellationSchema、OrderCancellationRespondSchema、OrderCancellationWithdrawSchema；`testOrderRules():OrderRulesSnapshot`、`dueDeadline(order:OrderView,now:Date):'DETAILS'|'PAYMENT'|'FULFILLMENT'|'INSPECTION'|null`、`CLOCK`／Clock。Proposal 新增 CONVERTED 和可空 orderId，非 CONVERTED 旧视图保持兼容，CONVERTED 必须具备关联订单 ID。

- [ ] **Step 1: 写契约与策略失败测试。** 正整数 expectedVersion、未知字段、不可传金额／side／受益人、取消历史 ID、时间格式、跨侧数量、脱敏投影；策略仅检查当前阶段，终态和结算不受旧截止时间影响。

```ts
expect(OrderPaymentSchema.safeParse({ expectedVersion: 1, purpose: 'DEPOSIT', amountFen: 1 }).success).toBe(false);
expect(testOrderRules()).toMatchObject({ depositFen: 1000, feeFen: 0, detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72 });
expect(dueDeadline(paymentOrder, new Date(paymentOrder.paymentDeadline!))).toBe('PAYMENT');
expect(dueDeadline({ ...paymentOrder, status: 'SETTLING' }, farFuture)).toBeNull();
```

- [ ] **Step 2: 观察 RED。** `npm test --workspace @barter/contracts -- orders.test.ts`；随后构建 contracts，再 `npm exec --workspace @barter/api -- vitest run src/orders/order-policy.spec.ts`。应因缺少 schema／策略或断言失败，不因数据库连接失败。
- [ ] **Step 3: 最小实现。** 所有 schema 为 strictObject；姓名 1～80、电话 5～32、地区 1～200、地址 4～500 字符，取消 reason 4～300、异议 4～1000；去首尾空白，carrier 2～32、trackingNumber 3～64 并标准化大写。运单不允许物品集合字段。时钟默认 SystemClock，不用全局 fake timers 改 JWT 时间。errors.ts 增加规格 API 章节列出的全部错误码，保持现有 ApiErrorBody／requestId 格式。
- [ ] **Step 4: GREEN。** 重跑上述测试及 `npm run typecheck`；旧提案契约测试继续通过。
- [ ] **Step 5: 审查并提交。** `feat: define order contracts and lifecycle rules`。只加入本任务文件，不导出无占用建单接口。

## Task 2: 增量持久化、统一占用和独立测试库

**Files:** Modify `apps/api/prisma/schema.prisma`、`prisma.config.ts`，新增 `apps/api/prisma/migrations/<Prisma生成时间戳>_orders/migration.sql`；Create reservations 三个文件、`reservation-policy.spec.ts`；Modify `items/public-items.service.ts`、`items/items.module.ts`、`proposals/proposals.service.ts`、`proposals/proposals.module.ts`、`proposals/proposal.mapper.ts`；Create `apps/api/vitest.phase3.config.ts`、`test/phase3/support/database-global-setup.ts`、`database-fixtures.ts`、`legacy-database-global-setup.ts`、`legacy-database-setup.ts`、`persistence.e2e-spec.ts`、`migration-upgrade.e2e-spec.ts`；Modify API package.json、vitest.config.ts、tsconfig.json、package-lock.json，以及六个旧 API 集成测试的文件边界清理（admin-item-review、auth-rbac、customer-items、item-image-upload、proposals、public-items）。

**Interfaces:** `reservationIsAvailable(reservation:ItemReservation|null,now:Date):boolean`；`ReservationsService.lockItems(tx,ids:string[]):Promise<void>`、`assertProposalLease(tx,proposalId,proposalVersionId,itemIds,now):Promise<void>`、`handoffToOrder(tx,proposalId,orderId,itemIds):Promise<void>`、`releaseOrder(tx,orderId):Promise<void>`。测试支持 `createPhase3Database():Promise<{url:string,close():Promise<void>}>`。

- [ ] **Step 1: 写失败测试。** 测试新表／约束、互斥所有者、完整交接、不可变内容、原物品不受订单租约时间影响；升级测试先在新建临时库只部署原两次迁移，保存六件租约和历史，再部署新迁移并逐字段比较。

```ts
expect(reservationIsAvailable({ ...lease, orderId, proposalId: null, proposalVersionId: null, expiresAt: null }, farFuture)).toBe(false);
expect(await beforeUpgradeSnapshot()).toEqual(await afterUpgradeSnapshot());
await expect(updateOrderItemSnapshot()).rejects.toThrow(/immutable/i);
await expect(insertReservationWithTwoOwners()).rejects.toThrow(/check constraint/i);
```

- [ ] **Step 2: 观察 RED。** 单独运行 policy 测试；数据库正常后 `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts persistence.e2e-spec.ts migration-upgrade.e2e-spec.ts`。缺表／字段／约束是预期 RED。
- [ ] **Step 3: 最小实现。** 按固定模型键生成未应用迁移并用 apply_patch 加 CHECK、触发器、部分唯一索引，包括 AuditLog 的 UPDATE／DELETE 不可变保护；`npm run db:migrate --workspace @barter/api -- --create-only --name orders`，开发库与显式 SHADOW_DATABASE_URL 均限制在本次随机命名空间，不同意 drift reset。generate 后逐一改造创建／counter／accept／公开查询的占用判定，处理 expiresAt 可空；取消和 expire 只释放提案所有者行，按同一排序锁定。ProposalsModule 注入 CLOCK，将裁决当前时间改为 Clock.now，默认行为不变，让转换与提案清理共用测试时钟。
- [ ] **Step 4: GREEN。** 在临时 PostgreSQL 库运行迁移和上述测试、旧 proposals／public-items 测试及 typecheck。新数据库配置仅包含 `test/phase3/**/*.e2e-spec.ts`，原配置排除这一目录；API `test` 顺序运行原配置和 phase3 配置，lint／tsconfig 显式包含新配置文件。global setup 创建已迁移的临时模板，旧 API 配置的模板另执行原种子；每个新旧集成测试文件克隆独立数据库，纯单元测试不分配数据库。旧配置 setupFiles 在测试模块求值前设置 DATABASE_URL，覆盖顶层 Prisma 构造；保留文件并行、禁止同文件并发，以逆序 afterAll 在文件 app／client 关闭后清理并恢复环境。删除旧文件边界的审计／报价／用户清理和 DISABLE TRIGGER 绕过，文件内原测试断言、业务性 fixture 操作保持。所有名字必须符合 `barter_p3_<本次随机命名空间>_*`、小于 PostgreSQL 标识长度；退出关闭连接后只删除自己创建的数据库，绝不删除 DATABASE_URL 原库。失败保留清理错误，不强删无关数据。

**Task 2 范围澄清（2026-10-02）：** 规格要求审计历史数据库不可变，但前两次迁移缺少 AuditLog 保护，旧测试通过删除审计和临时禁用报价保护清理共享数据库。执行控制器确认以新增迁移补齐保护，并最小扩展旧集成测试隔离，按文件丢弃本次拥有的临时库；不修改旧迁移、关闭保护或通过串行化隐藏冲突。

**Task 2 审查修正 I1（2026-10-03）：** 原 API 配置拆为 Vitest 内联 unit／integration projects，共享既有 forks、隔离与文件并行配置；只有 integration project 注册模板 globalSetup 和文件 setupFiles，由 Vitest 原生测试选择决定初始化，禁止解析 CLI 文件名猜测。增加子进程回归，移除 DATABASE_URL 及全部 PHASE3_* 后分别运行 reservation-policy／order-policy，确保纯单元选择既不克隆数据库也不初始化模板；保持旧 API 并行集成及 phase3 持久化／升级覆盖。
- [ ] **Step 5: 审查并提交。** `feat: persist orders and unify item reservations`。记录升级证据；数据库未可用时不得声称任务完成。

## Task 3: 原子建单、订单查询与用户命令边界

**Files:** Create `auth/customer-only.guard.ts`；Create orders 的 mapper／commands／service／controller／module、`proposals/proposal-order-handoff.service.ts`；Modify AppModule、ProposalsModule、proposal mapper；Create `test/phase3/support/order-harness.ts`、`order-conversion.e2e-spec.ts`、`orders-query.e2e-spec.ts`。

**Interfaces:** `ProposalOrderHandoffService.prepare(tx,actorId,proposalId,expectedVersion,now):Promise<ConfirmedOffer>`、`markConverted(tx,proposalId,orderId):Promise<void>`，ConfirmedOffer 含来源、参与人、完整现版和 itemIds。`OrdersService.convert(actor:AuthenticatedUser,id,input:OrderCommandInput,key,requestId?):Promise<OrderCommandResult>`、`detail(actor,id):Promise<OrderView>`、`list(actor,{cursor?,status?,limit?}):Promise<OrderListView>`。`OrderCommandsService.execute(context:OrderCommandContext,mutate:OrderMutation):Promise<OrderCommandResult>`，context 包含 actor／id／input／key／commandName／requestId；mutation `(tx,order:LockedOrder,now)=>Promise<{auditAction:string,paymentIntentId?:string}>`；框架统一修订、脱敏审计和响应。`orderInclude`、`mapOrder(order):OrderView`。

测试 harness 提供 app／prisma／可注入 clock、initiator／recipient／outsider／operator／mixed actors、`confirmedProposal({offeredCount?,mode?,differenceFen?,payer?})`、`command(actor,path,input,key?)`／`get(actor,path)` 的 Supertest 响应、`convert(proposal,actor?,key?)`、`faultAuditOnce(afterInsert?:boolean)` 和 `close()`；每个测试文件单独数据库，禁止后台自动扫描污染其他测试时钟。

- [ ] **Step 1: 写失败测试。** 两人竞争转换只创建一个订单；缺／错／多租约、过期边界、错版本、第三人、运营及混合角色；同键重放及跨资源哈希；审计插入后再抛错验证真正事务回滚。

```ts
expect(first.body.order.status).toBe('AWAITING_DETAILS');
expect(await h.prisma.order.count({ where: { proposalId } })).toBe(1);
expect((await h.command(h.actors.mixed, path, body)).status).toBe(403);
expect((await h.get(h.actors.outsider, `/api/orders/${id}`)).status).toBe(404);
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-conversion.e2e-spec.ts orders-query.e2e-spec.ts`，预期路由缺失／占用未交接。
- [ ] **Step 3: 最小实现。** 使用共同事务和排序锁；锁后核对实际时间、完整现版与租约，再创建规则／条款／物品快照和双方进度，面交待支付、快递待资料。关联订单从唯一 Order.proposalId 查询，不建立双向循环外键。第二方新键返回 409 PROPOSAL_ALREADY_CONVERTED 并提供关联标识；原成功键仍 201 重放。列表 `(createdAt DESC,id DESC)`、默认20／最大100、严格解码游标。execute 初期遇到到期仅明确拒绝，不开放未实现资金／发货命令；任务10完成共同到期转换。
- [ ] **Step 4: GREEN。** 上述测试、原 proposal 测试、lint／typecheck；断言租约原位转 orderId、旧 expire／cancel 不释放、详情／幂等均无敏感字段。
- [ ] **Step 5: 审查并提交。** `feat: convert confirmed proposals into atomic orders`。

## Task 4: 加密收货资料与最小授权读取

**Files:** Create `orders/address-cipher.ts`、`address-cipher.spec.ts`、`order-address.service.ts`；Modify orders controller／module；Create `test/phase3/order-address.e2e-spec.ts`；Modify `.env.example`。

**Interfaces:** `AddressCipher.encrypt(address:OrderAddressView,{orderId,side,version}):EncryptedAddress`、`decrypt(value,context):OrderAddressView`，EncryptedAddress 含 keyVersion／nonce／tag／ciphertext。`OrderAddressService.save(actor,id,input,key):Promise<OrderCommandResult>`、`get(actor,id,{side:'self'|'outgoing'}):Promise<OrderAddressView>`。

- [ ] **Step 1: 写失败测试。** 随机 nonce、AAD 防跨订单／侧重放、错误 tag／key；只改自己、冻结后拒绝；付款前不能读对方；资金满足后自己的发货资料访问有审计；原始库、审计和幂等缓存均无明文。

```ts
expect(cipher.encrypt(address, context).ciphertext).not.toEqual(cipher.encrypt(address, context).ciphertext);
expect(JSON.stringify(await h.prisma.idempotencyRecord.findMany())).not.toContain(address.phone);
expect(JSON.stringify(await h.prisma.auditLog.findMany())).not.toContain(address.detail);
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run src/orders/address-cipher.spec.ts`；`npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-address.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** AES 参数按工具说明；使用 ADDRESS_ENCRYPTION_KEY_BASE64 和 ADDRESS_ENCRYPTION_KEY_VERSION，不提交密钥。未配置时能力明确503，绝不明文回退；纯前阶段 API 启动无需解密资料。双方齐全后冻结并启动24小时支付期限；POST 仅摘要，独立 GET 权限投影和对方资料访问审计，禁止列表带明文。
- [ ] **Step 4: GREEN。** 上述测试及 typecheck；用 harness 临时完成资金前置条件测试读取，不注册假支付业务路由。
- [ ] **Step 5: 审查并提交。** `feat: protect order shipping details`。

## Task 5: 可核对的外部适配器和持久化 outbox

**Files:** Create integrations types／config／outbox／worker／registry／simulated adapters／store／module，payment.port.ts、logistics.port.ts；Create `src/integrations/integration-config.spec.ts`、`test/phase3/outbox.e2e-spec.ts`；Modify AppModule／`.env.example`。

**Interfaces:** `OutboxService.enqueue(tx,operation:ProviderOperation):Promise<OutboxCommand>`；`OutboxWorker.tick():Promise<void>`；registry `register(kind,handler:IntegrationOperationHandler)`，handler `query(operation):Promise<ProviderResult>`、`execute(operation):Promise<ProviderResult>`、`apply(operation,result):Promise<void>`。PaymentPort 的创建／关闭／退款／结算方法接收 ProviderOperation，查询方法接收 businessNo:string，均返回 Promise<ProviderResult>；方法名称固定 createPayment／queryPayment／closePayment／refundPayment／queryRefund／settleDifference／querySettlement。LogisticsPort `verifyShipment(operation:ProviderOperation):Promise<ProviderResult>`、`queryShipment(businessNo:string):Promise<ProviderResult>`。模拟 adapter 的 `verifySignedEvent(raw:string,signature:string):VerifiedIntegrationEvent` 只为测试 provider 验签；SimulatedProviderStore `successCount(businessNo:string):Promise<number>` 查询独立持久化的成功执行次数。`selectIntegration({nodeEnv,provider}:{nodeEnv:string,provider:string}):'disabled'|'simulated'` 校验环境与名称。

- [ ] **Step 1: 写失败测试。** 并发 worker 只领取一次、租约回收、先查询同编号；外部成功后 worker 崩溃再次查询不重复执行；UNKNOWN 不重发；生产模拟／未知provider拒绝，未配置能力503。

```ts
expect(await simulatedStore.successCount(operation.businessNo)).toBe(1);
expect(await h.prisma.outboxCommand.count({ where: { businessNo: operation.businessNo } })).toBe(1);
expect(() => selectIntegration({ nodeEnv: 'production', provider: 'simulated' })).toThrow();
```

- [ ] **Step 2: 观察 RED。** config unit 测试，再 `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts outbox.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** outbox 业务号唯一，领取30秒租约、使用 SKIP LOCKED，正常每秒 tick；UNKNOWN／未完成每30秒核对同号，绝不将超时转换为新请求。仅首次未执行或查询明确 NOT_FOUND 可 execute；已执行不再创建新号。模拟外部结果独立持久化，在订单事务外提交；未知handler保留明确不可执行，不默认成功。生产拒绝模拟，disabled provider 明确503，测试没有长睡眠。
- [ ] **Step 4: GREEN。** 上述测试、typecheck；断言跨 provider 网络调用时不存在未释放的订单事务，worker 关闭清理 timer。
- [ ] **Step 5: 审查并提交。** `feat: add durable integration commands and test adapters`。

## Task 6: 取消协商及安全取消转换

**Files:** Create `orders/order-cancellation.service.ts`；Modify orders controller／module；Create `test/phase3/order-cancellation.e2e-spec.ts`。

**Interfaces:** `OrderCancellationService.request,respond,withdraw(actor,id,input,key):Promise<OrderCommandResult>`；`begin(tx,order:LockedOrder,reason:string,actorId:string|null,now:Date):Promise<void>`、`tryFinalize(tx,orderId,now):Promise<boolean>`。begin 产生 CLOSE_PAYMENT／REFUND_PAYMENT outbox；tryFinalize 只有无交接且全部义务明确关闭／已返还时才能释放。

- [ ] **Step 1: 写失败测试。** 发起人不能替对方同意、不能回应历史请求、一份未决请求、防重、拒绝／撤回、已有运单／面交禁止、审计插入后失败回滚。未创建支付单可同事务取消；已有资金或未知结果保持占用。

```ts
expect(agreed.body.order.status).toBe('CANCELLED'); // 无支付单、无交接的用例
expect(await h.prisma.itemReservation.count({ where: { orderId } })).toBe(0);
expect(paidCancellation.body.order.status).toBe('CANCEL_PENDING');
expect(await h.prisma.itemReservation.count({ where: { orderId: paidOrderId } })).toBe(6);
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-cancellation.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** 只允许 AWAITING_DETAILS／PAYMENT／FULFILLMENT 且未登记任何交接；保存每次取消历史，不续期。未决取消对支付可核对，但新发货／交接／结算被禁止。资金条件由数据库事实而非按钮决定；退款回执尚未实现前，已付取消保持 CANCEL_PENDING，不提前显示取消成功。
- [ ] **Step 4: GREEN。** 上述测试及 conversion 回归，数据库部分唯一和 execute 版本策略覆盖并发同意／撤回。
- [ ] **Step 5: 审查并提交。** `feat: negotiate safe order cancellation`。

## Task 7: 双方付款、可信资金事件与取消退款

**Files:** Create payments service／events／outbox handler／module；Create integrations testing controller；Modify orders controller／module、integration registry；Create `test/phase3/order-payments.e2e-spec.ts`、`payment-events.e2e-spec.ts`；Modify `.env.example`。

**Interfaces:** `PaymentsService.start(actor,id,input,key):Promise<OrderCommandResult>`、`checkout(actor,id,intentId):Promise<CheckoutView>`；`PaymentEventsService.applyVerified(event:VerifiedIntegrationEvent):Promise<void>`；`PaymentOutboxHandler` 实现任务5 handler。测试 `POST /api/testing/payments/:intentId/complete` 仅纯CUSTOMER本人，要求 Idempotency-Key／订单 expectedVersion，固定模拟成功金额从 intent 推导；先改变独立模拟外部事实，再经可信事件处理，审计失败可核对恢复。

- [ ] **Step 1: 写失败测试。** 双1000分保证金及必要差价方向；零差价无义务；金额／币种／签名／关联错误不放行，未知可信业务号保留隔离事件；重复／乱序／晚到成功、跨用户checkout与跨订单幂等；外部成功后审计失败重跑只一份资金确认。

```ts
expect(intent.amountFen).toBe(1000);
expect((await h.get(h.actors.recipient, initiatorCheckout)).status).toBe(403);
expect(await h.prisma.financialEntry.count({ where: { intentId, entryType: 'PAYMENT' } })).toBe(1);
expect(cancelled.status).not.toBe('AWAITING_FULFILLMENT');
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-payments.e2e-spec.ts payment-events.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** 唯一付款义务／业务号，only purpose 输入；创建意图及 CREATE_PAYMENT 任务同审计事务，checkout不创建意图。可信结果先解析关联，再锁订单、去重、验证固定金额并写不可变资金记录；全部条件满足且未过支付期限、无取消／hold 才启动共同72小时履约。过期成功使用 cancellation.begin；CANCEL_PENDING 晚到成功补退款，ON_HOLD 只保留资金事实和异常待办，不擅自释放资金／占用；close／refund 回执确认后才调用 tryFinalize，未知保留占用，矛盾终态写异常待办不覆盖新占用。模拟签名密钥通过约定环境变量注入，生产不注册 testing 路由。
- [ ] **Step 4: GREEN。** 付款、事件、取消与outbox全量；人为让 AuditService 先真实插入后抛错，确认模拟外部成功保留、订单／资金／audit回滚，query重试可恢复且不再 execute。
- [ ] **Step 5: 审查并提交。** `feat: coordinate order funding and cancellation refunds`。

## Task 8: 双向快递、可信物流与面交

**Files:** Create logistics port consumers service／events／outbox handler／module；Create `orders/order-handover.service.ts`；Modify order／testing controllers、registry；Create `test/phase3/order-fulfillment.e2e-spec.ts`、`logistics-events.e2e-spec.ts`。

**Interfaces:** `ShipmentsService.submit(actor,id,input,key):Promise<OrderCommandResult>`；`LogisticsEventsService.applyVerified(event):Promise<void>`；`OrderHandoverService.confirm(actor,id,input,key):Promise<OrderCommandResult>`；LogisticsOutboxHandler 实现任务5接口。模拟 `POST /api/testing/shipments/:shipmentId/progress` 只自己的出件，expectedVersion／幂等，progress=COLLECTED|DELIVERED|EXCEPTION，经模拟适配器可信事件路径；DELIVERED 不能由该驱动跳过 COLLECTED。

- [ ] **Step 1: 写失败测试。** 资金不齐、未决取消、错模式／身份、重复规范化运单、漏件输入、无揽收不运输；双方共截止、乱序事件、先收到一方独立截止、异常不恢复；面交单方不代对方、首次交接后不能安全取消。

```ts
expect(submitted.body.order.status).toBe('AWAITING_FULFILLMENT');
expect(afterBothCollected.status).toBe('IN_TRANSIT');
expect((await cancelAfterTracking()).body.code).toBe('ORDER_FULFILLMENT_STARTED');
expect(await incomingDeadlineMinusDelivered()).toBe(72 * 60 * 60 * 1000);
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-fulfillment.e2e-spec.ts logistics-events.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** 运单绑定自己的整侧快照及冻结地址引用，outbox不包含明文；登记即取消保护，可信揽收／签收分开。两边揽收进入运输；有单侧来件签收即建立该侧验收截止，双方到达进入待验收。验收期限使用服务端接受可信签收的 Clock.now 起算，保留 occurredAt 作为外部事实，不让外部未来时间延长期限。面交两侧各自确认，双方完成后才建立双方来件验收状态；从不调用物流适配器。期限边界先拒绝，不靠可信事件晚到恢复hold。
- [ ] **Step 4: GREEN。** 上述测试及取消／资金回归；确认外部物流调用在业务事务之外、错误／重复事件不新增进度审计。
- [ ] **Step 5: 审查并提交。** `feat: track dual shipments and in-person handover`。

## Task 9: 双方验收、异常锁定与最终结算

**Files:** Create `orders/order-acceptance.service.ts`、`order-hold.service.ts`，payments settlement.service.ts；Modify order／testing controllers、payment events／handler；Create `test/phase3/order-settlement.e2e-spec.ts`、`order-issues.e2e-spec.ts`。

**Interfaces:** `OrderAcceptanceService.accept(actor,id,input,key):Promise<OrderCommandResult>`、`issue(actor,id,input,key):Promise<OrderCommandResult>`；`OrderHoldService.enter(tx,order,reason,now):Promise<void>`；`SettlementService.begin(tx,order,now):Promise<void>`、`tryFinalize(tx,orderId,now):Promise<boolean>`。完成返回与修订通过同一 mapOrder。

- [ ] **Step 1: 写失败测试。** 自己来件未到／已逾期拒绝，不能代对方；双方验收才SETTLING；零差价无结算任务；部分／UNKNOWN不能完成、重复保证金返还不重复；异议锁定与验收／worker竞争；审计失败回滚最终下架与释放。

```ts
expect(afterFirstAccepted.status).not.toBe('SETTLING');
expect(afterBothAccepted.status).toBe('SETTLING');
expect(partialSettlement.status).not.toBe('COMPLETED');
expect(await originalItemStatuses()).toEqual(Array(6).fill('INACTIVE'));
expect(await originalOwners()).toEqual(beforeOwners);
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-settlement.e2e-spec.ts order-issues.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** 只在自己可信收到且期限有效、无取消／hold时验收；先到的一方可以独立验收。双方验收原子产生差价结算和两份保证金全额返还任务；与取消共享唯一返还义务，防止双退。worker发新任务前重验状态，已在途结果继续核对但不另建号。全部确认才能完成、原物品INACTIVE／修订递增／释放；矛盾及异议锁定，无运营解锁／裁决入口。
- [ ] **Step 4: GREEN。** 结算／异议、资金事件与物流回归；真实资金记录不可变测试通过，completed／cancelled旧事件不倒退。
- [ ] **Step 5: 审查并提交。** `feat: finalize exchange acceptance and settlement`。

## Task 10: 共同到期转换、定时执行与并发裁决

**Files:** Create `orders/order-expiry.service.ts`、`order-expiry.scheduler.ts`；Modify commands／orders service、payment／logistics events、modules；Create `test/phase3/order-expiry.e2e-spec.ts`、`order-races.e2e-spec.ts`。

**Interfaces:** `OrderExpiryService.reconcile(id:string):Promise<boolean>`、`reconcileDue():Promise<void>`；`OrderExpiryScheduler.tick():Promise<void>`。reconcile 先锁订单重读，调用 cancellation.begin 或 hold.enter，不复制状态机。用户GET核验参与身份后reconcile；运营GET不触发；命令遇到到期先回滚自身、独立reconcile，再返回409。

- [ ] **Step 1: 写失败测试。** 四类截止的精确边界、延迟scanner、旧期限跨阶段、同键终态重放、审计插入后失败回滚；deterministic barrier证明建单／proposal取消／expire、付款／到期、运单／取消同意、验收／异议、worker／hold竞争，禁止仅Promise.all碰运气。

```ts
expect(await raceSuccessfulDecisions()).toBe(1);
expect(await impossibleOrderReservationPairs()).toHaveLength(0);
expect((await originalSuccessReplay()).body).toEqual(originalSuccess.body);
expect((await newExpiredCommand()).body.code).toBe('ORDER_EXPIRED');
```

- [ ] **Step 2: 观察 RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase3.config.ts order-expiry.e2e-spec.ts order-races.e2e-spec.ts`。
- [ ] **Step 3: 最小实现。** 每60秒scanner并防同实例重入；多实例靠数据库锁与状态条件。details／payment取消，未双方揽收／交接的共同履约到期hold，尚未验收的个人deadline到期hold；旧deadline不误伤SETTLING／CANCEL_PENDING／终态。等待物品／订单锁后再读取Clock.now，所有系统转换有null actor审计，不在错误事务内丢清理。
- [ ] **Step 4: GREEN。** 全阶段API与并发矩阵重复跑至少3次，测试无sleep等待巧合／锁泄漏；`npm run verify`，若DB阻塞明确记录而非跳过验证声明完成。
- [ ] **Step 5: 审查并提交。** `feat: enforce order deadlines and race-safe transitions`。

## Task 11: 小程序订单工作台

**Files:** Create `features/orders/order-api.ts`、`order-api.test.ts`；Create `pages/orders/list/index.tsx`、`detail/index.tsx`、`address-form.tsx`、`payment-actions.tsx`、`fulfillment-actions.tsx`、`orders.test.tsx`；Modify app.config.ts、globals.d.ts、lib/api-client.ts、proposal detail和mine入口、config/index.ts。

**Interfaces:** OrderApi `convertProposal,listMyOrders,getOrder,saveAddress,getShippingAddress,startPayment,getCheckout,submitShipment,confirmHandover,acceptOrder,reportIssue,requestCancellation,respondCancellation,withdrawCancellation` 严格映射共享schema；`runLogicalCommand(resourceId,action,input):Promise<OrderCommandResult>` 保存body／key，网络和5xx保留，确定性冲突刷新后重新确认。

- [ ] **Step 1: 写失败组件／传输测试。** 真实入口、双方进度、模拟提示、自己的动作、资料／付款pending、快递／面交条件、取消阻挡；403／409刷新、旧请求不得覆盖新结果、结果不明重复点击复用键、无完整资料响应写本地缓存。

```tsx
expect(screen.getByText('测试支付／测试物流，不产生真实资金或寄递')).toBeVisible();
expect(retryHeaders['Idempotency-Key']).toBe(firstHeaders['Idempotency-Key']);
expect(screen.queryByRole('button', { name: '确认对方收货' })).not.toBeInTheDocument();
```

- [ ] **Step 2: 观察 RED。** `npm test --workspace @barter/miniapp -- order-api.test.ts orders.test.tsx`。
- [ ] **Step 3: 最小实现。** Taro组件与原session；资金状态只信API，测试付款／物流操作仅显式acceptance或development构建且API声明simulation时显示，生产flag拒绝。资料仅即时展示，不存session／日志。后端未实现真实付款时显示不可用，不假装调用微信支付成功；新增“我的订单”和转换后入口。
- [ ] **Step 4: GREEN。** 上述测试、全部miniapp测试、typecheck、`npm run build:weapp --workspace @barter/miniapp`；设置 TARO_APP_IDENTITY_PROVIDER=acceptance、TARO_APP_ENVIRONMENT=acceptance、TARO_APP_INTEGRATION_MODE=simulated 后运行 `npm run build:h5 --workspace @barter/miniapp`，命令后恢复原环境。新页没有越权按钮不代表省略API越权测试。
- [ ] **Step 5: 审查并提交。** `feat: add miniapp order fulfillment workbench`。

## Task 12: 运营订单只读 API 和响应式页面

**Files:** Create `apps/api/src/orders/admin-orders.controller.ts`、`admin-orders.service.ts`、`test/phase3/admin-orders.e2e-spec.ts`；Modify OrdersModule；Create `apps/admin/src/features/orders/order-list-page.tsx`、`order-detail-page.tsx`、`orders.test.tsx`；Modify router、api-client、responsive.css。

**Interfaces:** `AdminOrdersService.list({cursor?,status?,limit?}):Promise<OrderListView>`、`detail(id):Promise<OrderView>`；GET /api/admin/orders 与 /:id，Roles OPERATIONS／REVIEWER／SUPER_ADMIN；没有POST。前端 `listOrders(query)`、`getOrder(id)` 只GET。

- [ ] **Step 1: 写失败测试。** 三角色只读通过、客户403、未登录401、所有代付款／验收／取消写路由不存在；地址／checkout不泄漏，查询不触发到期变更；390px卡片和长ID无溢出，deadline只是显示。

```ts
expect((await operatorPost(`/api/admin/orders/${orderId}/acceptance`)).status).toBe(404);
expect(JSON.stringify(operatorDetail.body)).not.toContain(address.phone);
expect(await persistedStatusAfterOperatorGet()).toBe(beforeStatus);
```

- [ ] **Step 2: 观察 RED。** API phase3 admin-orders 测试及 `npm test --workspace @barter/admin -- orders.test.tsx`。
- [ ] **Step 3: 最小实现。** 独立只读service和脱敏mapper；列表统一稳定游标、状态和异常筛选；表格／手机卡片展示双方进度、资金核对／异常，不提供代操作、强制完成、直接退款或地址导出。
- [ ] **Step 4: GREEN。** API权限、admin组件、原review／proposal回归、admin构建；手机真实浏览器检验留任务13。
- [ ] **Step 5: 审查并提交。** `feat: add responsive read-only order operations`。

## Task 13: 双用户验收、CI、文档与整分支审查

**Files:** Create `e2e/support/orders.ts`、`two-customer-orders.spec.ts`、`order-cancellation.spec.ts`、`in-person-orders.spec.ts`、`admin-orders.spec.ts`；Modify playwright.config.ts、scripts/prepare-e2e.mjs、config/index.ts、.github/workflows/verify.yml、README.md、AGENTS.md、本规格及计划完成记录。

**Interfaces:** e2e helper沿用两身份login、真实上传／发布／审核准备，`prepareConfirmedExchange({mode,offeredCount,differenceFen,payer})` 仅准备前置提案；订单业务动作全部通过页面。测试驱动只推进可信外部事实，不直接写DB。

- [ ] **Step 1: 写四条失败Playwright流程。** 快递五换一含差价、两侧保证金、可信模拟揽收／签收、两侧验收和完成原物品不可投；未交接双方取消确认退款后重新可投；面交无运单双侧交接验收；390px运营只读。保留原三个流程，断言隔离session不共享token。

```ts
await expect(initiator.getByText('已完成')).toBeVisible();
expect(await originalPublicItemStatus()).toBe(404); // 原物品已INACTIVE
await expect(operator.getByRole('button', { name: '确认验收' })).toHaveCount(0);
```

- [ ] **Step 2: 观察 RED。** `npm run e2e -- two-customer-orders.spec.ts order-cancellation.spec.ts in-person-orders.spec.ts admin-orders.spec.ts`，先记录页面／流程断言失败，再修连接，不把Docker或端口故障当作RED。
- [ ] **Step 3: 最小接线及文档。** 准备步骤显式声明模拟provider／test环境和H5测试integration flag；地址与模拟签名密钥在进程或CI运行时生成并传至API，各进程一致，不写仓库。CI临时PostgreSQL角色允许新测试创建／清理自己的数据库；migration和seed非破坏性，避免重复rootreset。README说明模拟／真实边界、期限、取消保护、异常交接第四阶段、数据库隔离、密钥和既有Vitest runner事实；AGENTS新增Phase3必读文档及不可逆资金规则。记录Prisma7版本文档修正，不升级到8。
- [ ] **Step 4: 完整GREEN与独立审查。** 分别运行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run verify`、`npm run e2e`；保存各项退出码、测试数、浏览器trace及升级证据。整分支新审查代理检查需求与质量，发现问题由独立修复任务TDD并提交，再新审查；仅纯文档改动不反复重跑产品测试，行为修改必须重跑相关及最终gate。外部阻塞按实际记录，不冒称全部通过。
- [ ] **Step 5: 提交和收尾。** `test: verify dual-user order fulfillment`。更新任务—提交—审查—验证对照及本地阻塞；按finishing-a-development-branch呈现集成选择，未获第三阶段授权不自动推送／创建PR／合并main或删分支。完成标准是受控测试闭环，不是真实资金上线。

## 规格覆盖与完成清单

| 规格领域 | 所属任务 |
| --- | --- |
| 共享契约、测试规则、时钟、阶段期限 | 1、3、10 |
| 增量迁移、独占、不可变快照和终态物品 | 2、3、9 |
| 客户／运营／混合角色、参与者和幂等 | 3、4、7、12 |
| 地址加密、私有资料读取、缓存／审计脱敏 | 4、7、11、12 |
| 外部命令、可信回调、崩溃恢复与unknown | 5、7、8、9 |
| 取消、关闭付款、全额退款、晚到事件 | 6、7、10 |
| 快递、面交、可信来件、双方验收和hold | 8、9、10 |
| 差价结算、保证金返还、防双退与安全完成 | 7、9 |
| 小程序／运营页面、旧刷新与不确定重试 | 11、12、13 |
| 原三流程、新四流程、六质量门、CI与文档 | 13 |

- [ ] 13项及对应新代理审查、独立提交均完成，最终整分支审查无未处理重要问题。
- [ ] 六项检查与增量升级、权限、幂等、资金、并发和故障恢复验证通过，或明确记录本机无法解决的外部阻塞。
- [ ] 真实服务未接入、第四阶段异常待处理和生产上线依赖明确报告，不误称第三阶段已经支持真实资金试运营。
