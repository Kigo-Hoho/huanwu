# 第四阶段：售后与风险控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立两用户售后、私有证据、双向退货、受控模拟补偿与可审计运营风控闭环。

**Architecture:** 售后工单协调订单、归还、补偿与风险模块；不可修改的方案、批准与外部事实决定执行条件。数据库状态、审计、幂等和 outbox 同事务提交，外部调用在事务外执行，并按原业务号对账。各模块属于同一订单事务边界，按本计划顺序交付，不并行修改依赖模块。

**Tech Stack:** Node.js >=24.15.0、npm workspaces、TypeScript、NestJS、PostgreSQL 17、Prisma ORM 7、Zod、Taro 4/React、React/Vite/Ant Design；现有 Vitest、Supertest、Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-09-barter-after-sales-risk-design.md`（用户已确认）。

状态：用户已确认，开始按顺序执行。用户选择直接沿用当前工作区开发，不创建额外 worktree。分支 `codex/phase4-after-sales-risk`，产品基线 `f6d459f`，设计草案提交 `9f7b3ed`。本文件中的命令是待执行步骤，不是已经通过的检查。

## Global Constraints

- 不发起真实扣款、退款、补偿或物流业务；生产适配器不可用时明确拒绝，不静默模拟或本地存储回退。
- 所有金额为整数分，币种固定 CNY；API 时间统一 UTC ISO 8601。
- 已完成订单售后申请期 7 天；补证、方案回应、补偿支付、退货登记、收回确认各 72 小时；揽收后 7 天未送达转人工。
- 图片 JPEG/PNG/WebP，每张 8 MiB、最长边 8192、总像素 4000 万；每批 1～9 张；工单双方各最多 30 张，举报者每份举报最多 30 张。
- 原保证金只整笔退回，不罚扣；不实现部分退款。额外补偿和运费每方向分别最多 20000 分，原差价回转不超过原差价，一笔净补偿最多 60000 分。
- 交易冻结不禁用登录，不阻断售后、必要退货和已有退款；原终态订单不回退、不抢占后来交易。
- 资金动作需要两名不同 SUPER_ADMIN 批准，起草者不能批准自己的方案；人数不足明确待审批。
- 移动会话 15 分钟、桌面会话最多 30 分钟；ActionGrant 5 分钟、一次性，绑定身份/会话/设备/动作/资源/版本/内容。
- 用户命令要求纯 CUSTOMER；运营独立接口，服务端重新读取当前角色和权限；不能代用户确认物品或扣款。
- 所有业务写命令要求幂等键与资源版本；同键不同内容明确 409，成功重试不重复状态、审计、付款或授权消费。
- 敏感状态、不可修改事实、审计、幂等结果和 outbox 同事务；UNKNOWN 对账原业务号，不换号再次执行。
- ON_HOLD 不自动收货、退款、释放或恢复；超时不默认同意；COMPLETED/CANCELLED 历史状态保留。
- PostgreSQL 17，不用 SQLite、reset、强制 DROP 或改写历史迁移。所有测试迁移/seed/清理只在本次有归属临时库执行。
- 沿用逐任务新实现代理、新需求审查代理、新质量审查代理；修正交回原实现代理；全部通过才进入下一任务并提交。
- 本计划确认后才开始产品实现；不自动推送、创建 PR 或合并，结束时按用户届时授权处理。

## Review Focus

1. 乱序资金事实：退款/转付先于收款回调到达，保存待核验事实，不丢事件、不先释放占用（Task 9）。
2. 身份切换与旧网络响应：客户/运营换账号后不能显示前一人的证据，401 重认证不能把旧写命令交给新身份（Tasks 12、13）。
3. 全部归还中的部分失败：六件物品仅五件归还或资金未知时，不能结案、部分释放或自动重新上架（Task 10）。
4. 重新认证与版本竞争：grant 签发后权限撤销/设备撤销/方案更新，旧 grant 不能继续执行或泄露原结果（Tasks 2、6）。
5. 无法确定历史完成时间：迁移不能取 updatedAt 猜 7 天期限，也不能改旧终态或审计（Tasks 1、3）。

---

## 文件与接口组织

沿用每个领域自己的 Nest module/controller/service；新增 `after-sales`、`evidence`、`returns`、`compensation`、`risk`、`operator-security`。共享 DTO 放 `packages/contracts/src/{after-sales,evidence,returns,compensation,risk,operator-security}.ts`，在 `index.ts` 导出。管理 DTO 独立脱敏，不复用富用户视图。每个新增领域文件对应有意义的行为测试，不把所有逻辑堆进 OrdersService。

计划共 14 个任务，严格顺序执行。每任务 Step 5 都包含新需求审查和新质量审查，修复后复查；提交信息见对应步骤。主代理记录 RED/GREEN 命令、结果、审查结论和提交号到本文件的执行记录，不把计划中的示例当执行证据。

公共内部类型在 Task 1 定义：`CaseTx = Prisma.TransactionClient`；`CaseMutationContext = {tx: CaseTx; order: LockedOrder; case: LockedCase; now: Date; actor: AuthenticatedUser|null}`；`CaseCommandContext = {actor: AuthenticatedUser; caseId: string; input: CaseCommandInput; key: string; commandName: string; requestId?: string}`。`CaseCommandInput` 包含 `expectedCaseVersion`、`expectedOrderVersion`；涉及方案加 `resolutionVersion`；涉及管理敏感动作的服务方法另收 `OperatorActionContext`（Task 2）。`CaseCommandResult` 只包含脱敏工单和订单版本，不含凭证/私有文件。

事务调用者拥有一次版本递增；`...InTransaction` 方法不自行开启嵌套事务，不重复递增。锁序为按 ID 排序的用户限制行（需要时）→来源提案（需要时）→订单→工单/方案→排序的物品/占用→资金/退货/审批/grant。只持订单锁的第三阶段资金回调不再反向请求用户锁。

新增路由固定前缀 `/api`：POST `/orders/:id/after-sales` 创建，GET `/after-sales` 与 `/after-sales/:id` 自有查询；POST `/after-sales/:id/{response,withdraw,withdraw/respond,consent,keep-confirmation}`；POST同工单下 `/evidence`、`/return-address`、`/returns/{shipment,handover,confirmation}`、`/compensation/payment`，GET `/return-address?side=self|outgoing`、`/compensation/payments/:paymentId/checkout`；GET `/evidence/:id/content?variant=preview|original`。举报 GET/POST `/reports`、GET `/reports/:id`、POST `/reports/:id/evidence`。运营 GET `/admin/after-sales` 与 `/:id`，POST该工单下 `/{request-evidence,resolutions,adjudication,approvals,execute,reject,extend-deadline}`；风险 GET `/admin/{reports,risk-tasks}` 与各详情，POST `/admin/reports/:id/{claim,request-evidence,conclude}`、`/admin/risk/users/:id/{freeze,unfreeze}`、`/admin/risk/items/:id/{unpublish,clear-block}`、`/admin/risk/orders/:id/{pause,clear-block}`。安全 POST `/admin/security/devices`、GET `/admin/security/{devices,sessions}`、POST `/admin/security/devices/:id/{approve,revoke}`、`/admin/security/sessions/:id/revoke`、`/admin/security/grants`。审批/解除阻塞不是恢复订单，恢复只能执行CONTINUE方案。创建201，查询及其他业务成功200；统一现有错误响应格式。

### Task 1: 共享契约、数据库约束与独立测试底座

**Files:** Create 六个共享契约及各自 `.test.ts`；Create `apps/api/src/after-sales/case.types.ts`；Modify `packages/contracts/src/{index,errors}.ts`、`apps/api/prisma/schema.prisma`、`apps/api/src/payments/settlement.service.ts`；Create `apps/api/prisma/migrations/20261009000100_after_sales_risk/migration.sql`；Create `apps/api/vitest.phase4.config.ts`、`apps/api/test/phase4/support/{database-global-setup,after-sales-harness}.ts`、`apps/api/test/phase4/persistence.e2e-spec.ts`；Modify `apps/api/{package.json,vitest.config.ts}`、`apps/api/test/phase3/support/database-fixtures.ts`（仅扩展新测试入口，不改变历史迁移数量断言）。

**Interfaces:** Produces 各领域 `...Schema` 和 `z.infer` 类型，包括 CaseView/CaseListView/CaseCommandInput/CaseCommandResult、ResolutionInput、EvidenceView、ReturnView、CompensationView、RiskReportView、OperatorActionContext 的公开对应 DTO；内部 LockedCase 和 CaseMutationContext。测试 `createAfterSalesHarness(): Promise<AfterSalesHarness>` 提供 clock、prisma、app、actors（两用户、第三人、客服、风控、两个超级管理员、混合身份）、command/get、faultAuditOnce、close；订单准备复用现有第三阶段测试流程而非产品模块内部方法。

- [ ] **Step 1: 写失败测试。** 契约断言 `expect(NetCompensationSchema.safeParse({amountFen: 60001, payer: 'INITIATOR'}).success).toBe(false)`，零补偿 payer=NONE，拒绝小数和多余字段；持久化测试断言同订单第二份开放工单唯一冲突、修改/删除方案/证据/资金事实失败。历史完成审计含 completedAt 时回填相同时间，无证据时保持 null。

```ts
it('pins the inclusive net compensation ceiling', () => {
  expect(NetCompensationSchema.parse({ amountFen: 60000, payer: 'INITIATOR' }).amountFen).toBe(60000);
  expect(NetCompensationSchema.safeParse({ amountFen: 60001, payer: 'INITIATOR' }).success).toBe(false);
  expect(NetCompensationSchema.safeParse({ amountFen: 0, payer: 'INITIATOR' }).success).toBe(false);
  expect(NetCompensationSchema.parse({ amountFen: 0, payer: 'NONE' }).payer).toBe('NONE');
});
```
- [ ] **Step 2: RED。** `npm test --workspace @barter/contracts -- src/after-sales.test.ts`；先新增最小 phase4 config/自有数据库入口，再运行 `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/persistence.e2e-spec.ts`，确认失败来自缺少模型/约束而非污染源库。
- [ ] **Step 3: 实现模型、契约与迁移。** 建立设计第 10 节模型；加 Order.completedAt、根争议/原支付唯一引用、私有证据存储键和归还地址加密元数据、明确 hold blockers、期限延长记录。开放工单部分唯一索引；资金金额及去向约束；不可修改触发器。更新正常结算写 completedAt，回填只解析可信 ORDER_COMPLETED 审计，禁止用 updatedAt。先核对本地 Prisma 7 CLI 帮助，再生成/审阅迁移，只对拥有的临时库 migrate deploy。phase4 runner 不被 legacy runner 重复发现；测试库可复用现有安全的 phase3 namespace 工具，不另造无清理验证的创建库脚本。
- [ ] **Step 4: GREEN。** 重跑 Step 2、`npm run typecheck --workspace @barter/api`、既有数据库隔离与迁移兼容测试；证实旧三份迁移文件不变、源库表计数/迁移记录不变、临时库清理成功。
- [ ] **Step 5: 审查与提交。** 两次独立审查通过后提交 `feat: add after-sales contracts and persistence`；只暂存本任务契约、模型、迁移和测试入口文件。

### Task 2: 运营设备会话与动作级重新验证

**Files:** Create `apps/api/src/operator-security/{operator-security.module,operator-security.controller,operator-session.service,operator-device.service,action-grant.service,operator-action.types}.ts`、`apps/api/scripts/approve-operator-device.ts`；Modify `apps/api/src/auth/{auth.service,jwt-auth.guard}.ts`、`apps/api/src/{app.module,main}.ts`、`apps/api/{package.json,tsconfig.json}`（CLI类型检查/lint入口）；Test `apps/api/test/phase4/operator-security.e2e-spec.ts`。

**Interfaces:** Produces `OperatorActionContext = {actor: AuthenticatedUser; sessionId: string; deviceId: string; grantId: string}`；`ActionGrantService.consume(tx, context, binding): Promise<void>`，binding 精确包含 action/resourceId/expectedVersions/requestHash；`OperatorSessionService.assertCurrent(tx, context, capability): Promise<void>`。登录响应不返回设备 secret；服务器 CLI `approveDevice(deviceId, reason)` 只批准既有待批记录并审计。

- [ ] **Step 1: 写失败测试。** `expect(await h.mobileGrant('APPROVE_FUNDS')).toMatchObject({status:403})`；伪造 User-Agent/deviceKind 不提升权限；密码重验后 grant 5 分钟过期，换资源/内容/账号拒绝；设备/角色撤销即时失效；审计失败不消费 grant；15/30 分钟边界测试。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/operator-security.e2e-spec.ts`，确认新安全入口/授权行为尚缺失。
- [ ] **Step 3: 实现服务。** 设备登记生成随机绑定凭据，只存摘要，HttpOnly cookie（生产 Secure、受限 SameSite）；敏感会话必须携带有效 sid 和绑定 cookie，不接受客户端任意 deviceId。配置明确允许的运营 origin，跨域凭证/CORS/CSRF 校验不使用通配；开发本地例外仅非生产。移动默认权限、运维 CLI 首次批准、受信超级管理员非自批后续批准/撤销。旧无 sid token 只保留既有低风险查询/审核，不能获得第四阶段敏感权限。grant 绑定业务输入摘要（不含 grant 本身与密码），消费在业务事务内，成功幂等重试仍检查当前权限。CLI 执行只针对自有测试库，不对保留库自动批准。
- [ ] **Step 4: GREEN。** 重跑 Step 2 和 `npm exec --workspace @barter/api -- vitest run --config vitest.config.ts test/auth-rbac.e2e-spec.ts`。测试辅助补齐 `operatorLogin`、`enrollOwnedDevice`、`grant`，走真实 API/受控 CLI，不给生产加测试授权后门。
- [ ] **Step 5: 审查与提交。** `feat: add operator sessions and action-bound reauthentication`。

### Task 3: 工单创建、自有查询及基础处理状态

**Files:** Create `apps/api/src/after-sales/{after-sales.module,after-sales.controller,case-commands.service,case-reader,case.mapper,case-policy,after-sales.service,case-records.service}.ts`；Modify AppModule、OrderHoldService（保存多原因而非覆盖）；Test `apps/api/test/phase4/{cases,case-races}.e2e-spec.ts`。

**Interfaces:** Produces `AfterSalesService.open(actor, orderId, input, key): Promise<CaseCommandResult>`；`CaseCommandsService.run(context, mutate: (ctx: CaseMutationContext) => Promise<void>): Promise<CaseCommandResult>`；`readCase(tx, id): Promise<LockedCase|null>`；`CaseRecordsService.respond(context, input): Promise<CaseCommandResult>`；自有列表 `(createdAt,id)` 游标默认20最多50。

- [ ] **Step 1: 写失败测试。** 两方同时 open 仅一份开放工单/暂停审计；同键同内容同结果，改内容409；非参与人404、混合角色403；`completedAt + 7天` 边界拒绝，时间不明返回明确人工核验结果而不猜。开户审计失败回滚工单、订单版本和幂等记录。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/cases.e2e-spec.ts test/phase4/case-races.e2e-spec.ts`。
- [ ] **Step 3: 实现生命周期。** 读取权限先于缓存重放；OPEN/补证/回应/人工审核、拒绝方案原因、双方撤回请求与关闭；活跃风险或在途义务阻止撤回关闭，不自动恢复。CANCELLED 仅资金异常，终态订单不回退；已有 ON_HOLD 首次原因保留。关闭结果与后续根争议关联，避免重复处置。
- [ ] **Step 4: GREEN。** 重跑 Step 2，验证原订单自有查询、暂停、验收禁止和 API 错误映射回归。
- [ ] **Step 5: 审查与提交。** `feat: add participant after-sales cases and records`。

### Task 4: 私有证据上传、展示与原件审计

**Files:** Create `apps/api/src/evidence/{evidence.module,evidence.controller,evidence.service,evidence-storage.port,local-private-evidence.adapter,evidence-image-validator}.ts`；Modify API package.json/lock（必要的图片解码依赖）、CaseRecordsService；Test `apps/api/test/phase4/evidence.e2e-spec.ts`、图片验证单元测试。

**Interfaces:** Produces `EvidenceUpload = {bytes:Buffer;contentType:string}`；`EvidenceService.appendCase(context, description, files: EvidenceUpload[]): Promise<CaseCommandResult>`；`appendReport(actor, reportId, input, files, key): Promise<RiskCommandResult>`；`read(actor, evidenceId, variant: 'preview'|'original'): Promise<{bytes:Buffer;contentType:string}>`。`EvidenceStoragePort.save/read/deleteOwned` 使用不透明键，不产生公开 URL。report 授权接口先定义，Task 7 接通。

- [ ] **Step 1: 写失败测试。** 外人/无售后权限运营读404或403，客户不能读他人举报证据；9张通过、10张拒绝、累计31张拒绝；畸形JPEG/超像素/MIME伪造拒绝；展示无EXIF、原件摘要不变；原件下载审计失败不返回字节；无授权公开 URL 不可用。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/evidence.e2e-spec.ts`，图片解码测试须真实字节而非仅测试 mock。
- [ ] **Step 3: 实现附件。** multipart 1～9张，正文与版本严格验证，幂等摘要包含文件内容摘要及次序。使用经过核对官方文档的 sharp 解码/像素限制与去元数据预览，保留原件；单批元数据与计数锁、审计同事务。新增依赖按实际锁定版本配置需要的 npm allowScripts，不升级整个技术栈。文件先写私有对象，失败对象标识有限范围清理；原件/预览响应 Cache-Control:no-store，下载逐次鉴权。缺生产私有存储明确503。
- [ ] **Step 4: GREEN。** 重跑 Step 2、验证器测试以及原公开物品图片上传回归；断言私有证据从公开文件路由无法读取。
- [ ] **Step 5: 审查与提交。** `feat: add private immutable after-sales evidence`。

### Task 5: 不可修改方案、客户确认与裁决记录

**Files:** Create `apps/api/src/after-sales/{resolution.service,resolution-policy,admin-after-sales.controller,admin-after-sales.service}.ts`；Test `apps/api/test/phase4/resolutions.e2e-spec.ts`。

**Interfaces:** Produces `ResolutionService.propose(operator, caseId, input, key): Promise<CaseCommandResult>`、`consent(context, input): Promise<CaseCommandResult>`、`adjudicate(operatorContext, input, key): Promise<CaseCommandResult>`；`resolveCompensation(input, originalDifferenceFen): NetCompensation`（Task 1类型），每项明示方向和非负金额，净额服务端推导。

- [ ] **Step 1: 写失败测试。** 新版本使旧双方确认失效；两方仅自己确认；起草方案不代表用户验收；额外/运费20001拒绝、总净额60001拒绝，净零payer=NONE。EXECUTING 禁止直接换方案，终态订单方案不能倒退状态。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/resolutions.e2e-spec.ts`。
- [ ] **Step 3: 实现五类方案。** OPEN 可直接进入 UNDER_REVIEW 后起草，无需虚构补证。校验物品快照属于该订单；每个原款目标由服务端计划推导，禁止任意收款账号和业务号。客服可起草/补证，风控不能越权裁决资金；裁决保存证据与理由，不虚构同意。执行入口在 Task 6 授权后接通，之前明确不能执行，不提交假成功。
- [ ] **Step 4: GREEN。** 重跑 Step 2；验证方案、确认、记录不可修改触发器与新版本冲突。
- [ ] **Step 5: 审查与提交。** `feat: add versioned after-sales resolutions and consent`。

### Task 6: 双人资金审批与方案执行授权

**Files:** Create `apps/api/src/after-sales/{resolution-approval.service,resolution-execution.service,resolution-executor.port}.ts`；Test `apps/api/test/phase4/resolution-approval.e2e-spec.ts`。

**Interfaces:** Produces `ResolutionApprovalService.approve(context: OperatorActionContext, caseId, input, key): Promise<CaseCommandResult>`；`ResolutionExecutionService.start(context, caseId, input, key): Promise<CaseCommandResult>`；`ResolutionExecutor.planInTransaction(ctx, resolution): Promise<void>`，具体义务由 Tasks 8～10 注册实现。不支持的执行类型明确拒绝，不把空执行器当成功。

- [ ] **Step 1: 写失败测试。** 两名不同超级管理员批准后才执行资金方案，起草者、自批第二次、客服、移动会话均拒；grant后改版本/撤设备拒绝；审计失败回滚批准、grant消费和outbox；同键重试只一份执行记录。无资金CONTINUE仍需有权限且重新验证的恢复命令，不伪造资金审批。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/resolution-approval.e2e-spec.ts`。
- [ ] **Step 3: 实现审批门禁。** 消费Task2grant；客户同意/平台裁决资格与资金批准分离。批准不可修改，判断当前方案、有效身份、不同批准者与非起草者；变更自动使旧批准不适用。执行唯一绑定case/resolution/step，原资金 UNKNOWN 阻止冲突执行。并发签发授权和业务动作统一锁序，审批通过不授予任意外部资金调用权限。
- [ ] **Step 4: GREEN。** 重跑 Step 2、operator-security、resolutions。用客服起草、两个管理员批准；超级管理员起草测试增加第三个管理员 fixture，不降低非自批规则。
- [ ] **Step 5: 审查与提交。** `feat: gate resolution execution with dual financial approval`。

### Task 7: 举报、交易冻结、单项下架与异常运单待办

**Files:** Create `apps/api/src/risk/{risk.module,risk.controller,admin-risk.controller,risk-report.service,trading-restrictions.service,risk-actions.service,risk-task.service}.ts`；Modify `apps/api/src/items/{items.service,public-items.service}.ts`、`apps/api/src/proposals/{proposals.service,proposal-order-handoff.service}.ts`、`apps/api/src/logistics/logistics-events.service.ts`；Test `apps/api/test/phase4/{risk-reports,trading-freeze-races}.e2e-spec.ts`。

**Interfaces:** Produces `TradingRestrictionsService.lockAndAssert(tx, userIds: string[]): Promise<void>`、`RiskTaskService.recordInTransaction(tx, input): Promise<void>`；`RiskActionsService.freeze/unfreeze/unpublish/pause(context, resourceId, input, key): Promise<RiskCommandResult>`（Task1类型）。`activeBlockers(tx, orderId): Promise<RiskBlocker[]>` 供恢复服务使用。

- [ ] **Step 1: 写失败测试。** 公开物品/自有运单举报与匿名性；同目标同类开放举报去重；客服不能冻结；冻结与提案接受并发只有安全序列结果。冻结用户仍可登录、举证、退货；公开隐藏被冻结物主物品，解冻不自动恢复已下架物品。终态运单异常只追加待办。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/risk-reports.e2e-spec.ts test/phase4/trading-freeze-races.e2e-spec.ts`。
- [ ] **Step 3: 实现风险闭环。** OPEN/INVESTIGATING/ACTIONED/DISMISSED、认领补证结论与证据访问；创建交易限制基线行确保不存在记录也可锁。新发布/提交、双方提案修改/接受、转订单均检查双方当前限制；限制行按ID先锁，不批量遍历订单。下架增加独立风险阻塞，不能用户编辑绕过；物品解禁后走重新审核。Shipment EXCEPTION 在事实事务中去重待办并暂停非终态，禁止把运营证明直接改成DELIVERED。
- [ ] **Step 4: GREEN。** 重跑 Step 2、第一阶段发布审核、第二阶段提案并发和第三阶段物流异常回归；单项处置审计失败回滚。
- [ ] **Step 5: 审查与提交。** `feat: add reports and transaction-safe trading restrictions`。

### Task 8: 多物归还义务、退货物流与私有地址

**Files:** Create `apps/api/src/returns/{returns.module,returns.controller,return-plan.service,return-commands.service,return-logistics.handler,return-events.service,return-address.service}.ts`；Modify LogisticsPort、SimulatedLogisticsAdapter/SimulatedProviderStore、IntegrationTypes/HandlerRegistry 注册处；Test `apps/api/test/phase4/returns.e2e-spec.ts`。

**Interfaces:** Produces `ReturnPlanService.planInTransaction(ctx, resolution): Promise<void>`；`ReturnCommandsService.registerShipment/handBack/confirmReceived(context, input): Promise<CaseCommandResult>`；`ReturnAddressService.get(actor, caseId, side: 'self'|'outgoing')`（Task1地址DTO）；`ReturnEventsService.applyVerified(event): Promise<void>`。LogisticsPort 扩展 verifyReturn/queryReturn/closeOrIntercept/queryInterception，都采用 ProviderOperation/ProviderResult；原接口不换签名。

- [ ] **Step 1: 写失败测试。** 发起方5件/接收方1件逐件义务、合包无漏项；只一方交付不虚构另一方退货；注册原运单必须先核验拦截/关闭；面交交出与原物主确认不同角色；退货物流送达不自动确认；外人地址404，ON_HOLD 不因此开放原 outgoing地址接口。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/returns.e2e-spec.ts`。
- [ ] **Step 3: 实现归还。** 原物主自己提供/确认加密归还地址，复用AddressCipher算法和AAD规范但隔离ReturnAddress身份；方案执行冻结地址，只有实际退回方在该归还义务合法执行时可读outgoing，泛化管理/幂等响应不含明文。快递覆盖snapshotID集合严格核验，运单全局不能复用原/其他退货单；独立ReturnShipment/Event。短事务outbox登记/核验拦截，未知结果不假设物品未交付。物流真实事实和客户确认分离，未归还异常留人工裁决。
- [ ] **Step 4: GREEN。** 重跑 Step 2、原地址加密/泄露、原快递与面交回归；核验原Shipment不被覆盖、未知占用保留。
- [ ] **Step 5: 审查与提交。** `feat: add item-level returns and controlled reverse logistics`。

### Task 9: 独立补偿支付、可信资金事实与原款退款

**Files:** Create `apps/api/src/compensation/{compensation.module,compensation.controller,compensation.service,compensation.port,compensation-outbox.handler,compensation-events.service,compensation-ledger,case-funds-status.service}.ts`；Modify `apps/api/src/integrations/{integration.types,simulated-provider.store,testing-integrations.controller}.ts`、`apps/api/src/payments/payment-outbox.handler.ts` 售后授权分支；Test `apps/api/test/phase4/{compensation,after-sales-financial-races}.e2e-spec.ts`。

**Interfaces:** Produces `CompensationService.planInTransaction(ctx, resolution): Promise<void>`、`requestPayment(context): Promise<CaseCommandResult>`、`getCheckout(actor, caseId, paymentId): Promise<CompensationCheckoutView>`；`CompensationPort.create/query/close/refund/queryRefund/disburse/queryDisbursement` 采用现有 ProviderOperation/ProviderResult。`CompensationEventsService.applyVerified(event): Promise<void>`；`CaseFundsStatus = {complete:boolean;unknown:boolean;conflicting:boolean}`、`CaseFundsStatusService.inspect(tx, caseId): Promise<CaseFundsStatus>`（定义在本任务并供Task10使用）。

- [ ] **Step 1: 写失败测试。** 未审批不出款、裁决不主动扣客户款；净额60000通过/60001拒绝；退款与转付互斥、原差价不重复回转、原保证金无罚扣。乱序转付/退款事件先保存，收款到账后按原号补核验；外部成功但本地审计失败再次对账不二次执行；UNKNOWN始终保留占用。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/compensation.e2e-spec.ts test/phase4/after-sales-financial-races.e2e-spec.ts`。
- [ ] **Step 3: 实现独立资金域。** 新业务号 `compensation:payment:<paymentId>`、`compensation:refund:<paymentId>`、`compensation:disburse:<paymentId>` 全程稳定。引用方案/根争议/原支付、金额/币种/付款收款侧，独立账本唯一事实。原款退款沿用 `refund:<intentId>`，不改原PaymentPurpose唯一规则。对账可以入账既有外部事实，execute必须持合法且当前义务授权；处理并发authorize→I/O时间窗，记录在途执行认领，方案改动必须等待已认领业务核验。关闭/退款/转付状态互斥在模拟供应商和本地都保证；通用响应/幂等/审计不能保存checkout。测试驱动只在显式dev/test或acceptance H5启用，生产拒绝。
- [ ] **Step 4: GREEN。** 重跑 Step 2、原订单支付/退款/结算、outbox lease与未知回调回归；断言同一根义务付款/退款/转付次数与金额守恒。
- [ ] **Step 5: 审查与提交。** `feat: add independently reconciled simulated compensation`。

### Task 10: 安全恢复、方案收尾与占用释放

**Files:** Create `apps/api/src/after-sales/{order-intervention.port,order-intervention.service,case-finalization.service}.ts`；Modify ResolutionExecutionService、订单/退款/归还事实通知、ReservationsService公开事务接口；Test `apps/api/test/phase4/{case-finalization,case-resume}.e2e-spec.ts`。

**Interfaces:** Produces `OrderInterventionService.resumeInTransaction(ctx, resolution): Promise<void>`、`extendDeadlineInTransaction(ctx, {kind,side?}): Promise<void>`；`CaseFinalizationService.reconcile(caseId): Promise<boolean>`、`reconcileInTransaction(ctx): Promise<boolean>`。订单快照、资金和归还结果通过公开读/事务端口获得，不直接调用第三阶段私有方法。

- [ ] **Step 1: 写失败测试。** 六件物品仅五件归还、资金未知或活跃风险存在时 `expect(await reconcile(id)).toBe(false)` 且全部原占用仍在；完整处理后仅释放本订单占用；终态订单售后不抢占后来订单。恢复由最新事实推导，不盲用holdPreviousStatus；延期同类第二次拒绝，新截止=服务器批准时间+72小时。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/case-finalization.e2e-spec.ts test/phase4/case-resume.e2e-spec.ts`。
- [ ] **Step 3: 接通五类执行与收尾。** Return/cancel全部义务完成才CANCELLED；交付过/质量争议物品INACTIVE，未交付且无风险安全取消恢复ACTIVE；KEEP要求每方自有独立“收到且保留全部物品”确认，不能把consent当acceptedAt，也不能运营代签，之后补偿+原结算完才COMPLETED。CONTINUE安全恢复后立即结工单不阻塞正常履约；FUNDS_ONLY不改旧终态。允许明确无法归还的裁决需证据、责任、已批准资金目标，标注“裁决处置”而非“用户确认归还”。风险仍有任何独立阻塞不解除；旧未知资金优先核验、已发外部指令不得撤销。完成状态、物品、占用、审计同事务；回调重入不重复结案。
- [ ] **Step 4: GREEN。** 重跑 Step 2、Tasks8/9和原第三阶段完成/取消/迟到事件测试，审计故障注入证明无部分释放。
- [ ] **Step 5: 审查与提交。** `feat: finalize after-sales obligations and controlled order recovery`。

### Task 11: 请求与定时任务共用期限核验

**Files:** Create `apps/api/src/after-sales/{case-expiry.service,case-expiry.scheduler}.ts`；Modify CaseCommandsService、归还/补偿命令、风险待办；Test `apps/api/test/phase4/case-expiry.e2e-spec.ts`。

**Interfaces:** Produces `CaseExpiryService.reconcile(caseId): Promise<void>`、`reconcileInTransaction(ctx): Promise<void>`；scheduler重复执行同业务期限不重复待办/审计。测试harness禁用实际定时器，用MutableClock直接调用同转换服务。

- [ ] **Step 1: 写失败测试。** 72小时/7天前一毫秒与等于边界；任务未运行时写命令仍识别过期；重复scheduler仅一个待办；超时不默认consent、不罚扣、不确认退回、不释放占用；终态和CONTINUE已结案不再催办。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/case-expiry.e2e-spec.ts`。
- [ ] **Step 3: 实现期限。** 补证/方案回应到期转UNDER_REVIEW；登记退货、补偿支付、签收确认或揽收7天超时保留义务并去重风险待办。拒绝命令不能把过期记录悄悄回滚丢失：复用第三阶段独立reconcile后返回冲突模式。晚到可信事实仍可入账，义务是否解除重新核验，不按客户端时间重开方案。
- [ ] **Step 4: GREEN。** 重跑 Step 2、第三阶段超时任务回归、同一行并发请求与scheduler测试；真实等待用时钟推进，不sleep72小时。
- [ ] **Step 5: 审查与提交。** `feat: reconcile after-sales deadlines without implicit consent`。

### Task 12: 小程序售后、证据、补偿与归还页面

**Files:** Create `apps/miniapp/src/features/after-sales/{after-sales-api,after-sales-api.test}.ts`、`apps/miniapp/src/pages/after-sales/{create,list,detail}/index.tsx`、`{evidence-form,resolution-actions,return-actions,compensation-actions,after-sales.test}.tsx`；Modify api-client.ts、app.config.ts、订单详情/共享导航；Create 举报表单与交易冻结提示组件。

**Interfaces:** Produces `AfterSalesApi` 的 list/get/open/appendEvidence/respond/withdraw/respondWithdrawal/consent/confirmKeep/registerReturn/confirmReturn/requestCompensation/getCheckout/report 方法，均消费共享契约；客户身份读写沿用 AuthenticatedApiClient 的现有 epoch/credentialRevision 防线，扩展严格领域 path 联合类型，不另存token。

- [ ] **Step 1: 写失败测试。** 结果未知保留原幂等键和正文，改内容提示先核验；身份切换清除旧证据object URL并丢弃迟到响应；401不能新身份重放旧申请；方案同意按钮与物品保留确认分离；冻结仍显示售后/退货入口；模拟按钮非允许构建不可用。
- [ ] **Step 2: RED。** `npm test --workspace @barter/miniapp -- src/features/after-sales/after-sales-api.test.ts src/pages/after-sales/after-sales.test.tsx`。
- [ ] **Step 3: 实现客户闭环。** 展示工单/方案版本、责任及金额方向、待批准/资金未知/退货异常；私有证据采用身份绑定鉴权读取和及时回收的临时展示，不永久缓存。实际微信图片上传走Taro支持的multipart方式，H5用同契约，不假称H5浏览器等于真机验证。使用当前登录身份核验资源；仅RAM保存未决逻辑命令，不把图片/地址/checkout落本地缓存；409刷新版本需用户重新确认，不自动改价后提交。补偿付款只能当前明确付款方，举报入口只合法可見目标。
- [ ] **Step 4: GREEN。** 重跑 Step 2、全部miniapp测试、`npm run build:weapp --workspace @barter/miniapp`、`npm run build:h5 --workspace @barter/miniapp`，记录现有警告而非当错误忽略。
- [ ] **Step 5: 审查与提交。** `feat: add miniapp after-sales and return workflows`。

### Task 13: 响应式运营售后、风险与审批工作台

**Files:** Create `apps/admin/src/features/after-sales/{case-list-page,case-detail-page,resolution-form,approval-actions,after-sales.test}.tsx`、`apps/admin/src/features/risk/{risk-pages,risk.test}.tsx`、`apps/admin/src/features/security/{device-page,reauth-dialog,security.test}.tsx`；Create `apps/admin/src/lib/after-sales-api.ts`；Modify api-client.ts、router.tsx和样式。

**Interfaces:** Produces `AdminAfterSalesApi`（脱敏查询、补证、起草、审批、执行、风险命令）与 `OperatorSecurityApi`（设备登记/查询、会话撤销、grant），复用现有管理会话；密码只传重新验证请求，不进localStorage、日志、幂等或组件长期状态。

- [ ] **Step 1: 写失败测试。** 390px单项暂停/冻结可用，资金审批入口不开放；伪造客户端显示权限后API403仍清晰失败；客服不可资金执行；两管理员批准状态分别展示；401/账号切换清除前人证据/表单/grant，晚到旧详情不得渲染。
- [ ] **Step 2: RED。** `npm test --workspace @barter/admin -- src/features/after-sales/after-sales.test.tsx src/features/risk/risk.test.tsx src/features/security/security.test.tsx`。
- [ ] **Step 3: 实现管理页面。** 表格/卡片稳定分页，平台处理时间线不伪装用户，归还逐项/资金原号核验进度；设备待批准明确提示受控bootstrap方法，不自动批准。敏感命令先固定版本/正文再重验签发grant，错误恢复保持同逻辑命令key但不重用已失效权限。后台提示资金只是模拟；缺批准/风险阻塞明确显示。不增加自由状态/账户输入或批量资金按钮。
- [ ] **Step 4: GREEN。** 重跑 Step 2、全部admin测试、`npm run build --workspace @barter/admin`；检查390px和桌面布局。
- [ ] **Step 5: 审查与提交。** `feat: add responsive after-sales and risk workbench`。

### Task 14: 跨端验收、CI、指导文档与整分支审查

**Files:** Create `e2e/{after-sales-returns,after-sales-compensation,after-sales-risk}.spec.ts`、`e2e/support/after-sales.ts`；Modify prepare-e2e.mjs/测试、受控seed、README、AGENTS、.github/workflows/verify.yml、本计划执行记录；Create `docs/superpowers/reviews/2026-10-09-phase4-final-review.md`。

**Interfaces:** Consumes Tasks1～13，Produces 根 `npm run e2e` 售后流程、失败trace与源库隔离证明、README受控设备注册/双审批/模拟资金操作说明、实际最终审查记录。测试harness增加 owned 库专用客服和两个不同管理员；不向保留源库写账号或设备。

- [ ] **Step 1: 写失败浏览器验收。** 两用户争议→真实图片举证→客服退货方案→双方同意→两个独立桌面管理员审批→多物双向归还→整笔退款核验→结案；保留物品→独立确认→补偿模拟收款/转付→结案；移动冻结及桌面专属403、解冻/风险解除后受控恢复。断言旧物品未自动再上架、无二次付款、第三人无私有证据。
- [ ] **Step 2: RED。** `npm run e2e -- after-sales-returns.spec.ts after-sales-compensation.spec.ts after-sales-risk.spec.ts`；核实失败是尚未完成的跨端行为，不是手动migrate保留库或测试密码缺失。测试使用owner生成API运行时secret，不注入前端环境。
- [ ] **Step 3: 完成验收准备与文档。** 仅在自有临时库seed第二管理员/客服/已审批设备，走Task2真实受控注册流程；账户密码由环境/owner提供，不硬编码真实凭证。owned库迁移兼容当前schema，旧legacy/phase3 runner仍通过；清理await服务关闭与普通DROP、catalog和源表/迁移对比。CI维持PostgreSQL17及六个独立门槛；失败上传trace而不上传运行时secret或私有证据原件。README明确两人审批、来源业务号核验、桌面能力不是物理/MFA、生产缺外部适配器不可上线，AGENTS补读本阶段spec/plan和不能自动终结售后的规则。
- [ ] **Step 4: 全量GREEN与整分支审查。** 分别执行下面六条，保存每次退出码和摘要；新整分支审查代理比较 `f6d459f..HEAD`，覆盖契约、事务、资金、角色、设备、隐私与测试隔离。发现问题交回原相关实现代理修正、新复查；影响行为的修正先RED再GREEN，并重跑相关门槛。不得将没有运行/环境阻塞标成通过。

```text
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm run e2e
```

- [ ] **Step 5: 审查与提交。** `test: verify after-sales and risk-control slice`。报告14任务实际提交、六条结果、审查发现与修正、警告/外部阻塞；仅达到下列标准后报告阶段完成。推送或合并需用户相应授权。

## 完成标准与实施前检查

14任务全部完成并分别提交/审查；客户与运营两种售后路径可演示，权限/证据/资金/并发/期限/隔离测试通过；六项门槛通过，或外部环境阻塞有确切证据且未假报完成。真实资金与物流、生产私有存储及正式认证能力仍留第五阶段上线核验，模拟通过不等于生产上线。

实施前使用 using-git-worktrees 检测是否已经是独立worktree，再决定隔离方式，保留现有分支和用户改动；运行现有基线验证。Docker不可用时先做无容器工作，可使用已有 PostgreSQL 17 本地服务，但不能换SQLite；不可用的PostgreSQL服务记录为环境阻塞。不读取/输出已有私有env或归档secret。

Prisma 官方默认文档现已引导新命令体系，本项目仍固定 ORM 7；执行以[官方 v7 CLI 文档](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference)及本地 `prisma --version`/`migrate diff --help` 为准，继续使用 v7 的 migrate deploy，不照抄新主版本 `db migrate`。sharp 图片像素限制依据[官方构造参数文档](https://sharp.pixelplumbing.com/api-constructor/)；真正加入依赖时再核对锁定版本与metadata行为，不安装未经核对的最新版本。

## 执行记录（确认计划后逐任务填写）

设计及计划：用户于2026-10-09确认。实施准备：当前分支干净；用户明确选择沿用现有工作区；Docker daemon 未启动，使用新建、仅监听本机的 PostgreSQL 17 临时验证集群，不修改原保留业务库。14项任务均未完成，逐任务 RED/GREEN、审查、提交与最终六条门槛尚无本阶段结果。执行方式沿用子代理逐任务开发与独立审查。
