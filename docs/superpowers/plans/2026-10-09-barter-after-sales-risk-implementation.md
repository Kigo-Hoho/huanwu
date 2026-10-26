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

- [x] **Step 1: 写失败测试。** 契约断言 `expect(NetCompensationSchema.safeParse({amountFen: 60001, payer: 'INITIATOR'}).success).toBe(false)`，零补偿 payer=NONE，拒绝小数和多余字段；持久化测试断言同订单第二份开放工单唯一冲突、修改/删除方案/证据/资金事实失败。历史完成审计含 completedAt 时回填相同时间，无证据时保持 null。

```ts
it('pins the inclusive net compensation ceiling', () => {
  expect(NetCompensationSchema.parse({ amountFen: 60000, payer: 'INITIATOR' }).amountFen).toBe(60000);
  expect(NetCompensationSchema.safeParse({ amountFen: 60001, payer: 'INITIATOR' }).success).toBe(false);
  expect(NetCompensationSchema.safeParse({ amountFen: 0, payer: 'INITIATOR' }).success).toBe(false);
  expect(NetCompensationSchema.parse({ amountFen: 0, payer: 'NONE' }).payer).toBe('NONE');
});
```
- [x] **Step 2: RED。** `npm test --workspace @barter/contracts -- src/after-sales.test.ts`；先新增最小 phase4 config/自有数据库入口，再运行 `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/persistence.e2e-spec.ts`，确认失败来自缺少模型/约束而非污染源库。
- [x] **Step 3: 实现模型、契约与迁移。** 建立设计第 10 节模型；加 Order.completedAt、根争议/原支付唯一引用、私有证据存储键和归还地址加密元数据、明确 hold blockers、期限延长记录。开放工单部分唯一索引；资金金额及去向约束；不可修改触发器。更新正常结算写 completedAt，回填只解析可信 ORDER_COMPLETED 审计，禁止用 updatedAt。先核对本地 Prisma 7 CLI 帮助，再生成/审阅迁移，只对拥有的临时库 migrate deploy。phase4 runner 不被 legacy runner 重复发现；测试库可复用现有安全的 phase3 namespace 工具，不另造无清理验证的创建库脚本。
- [x] **Step 4: GREEN。** 重跑 Step 2、`npm run typecheck --workspace @barter/api`、既有数据库隔离与迁移兼容测试；证实旧三份迁移文件不变、源库表计数/迁移记录不变、临时库清理成功。
- [x] **Step 5: 审查与提交。** 为提供可复查的提交差异，先提交候选 `feat: add after-sales contracts and persistence`，两项独立审查及修正复查通过后才标记任务完成；只暂存本任务契约、模型、迁移和测试入口文件。

### Task 2: 运营设备会话与动作级重新验证

**Files:** Create `apps/api/src/operator-security/{operator-security.module,operator-security.controller,operator-session.service,operator-device.service,action-grant.service,operator-action.types}.ts`、`apps/api/scripts/approve-operator-device.ts`；Modify `apps/api/src/auth/{auth.service,jwt-auth.guard}.ts`、`apps/api/src/{app.module,main}.ts`、`apps/api/{package.json,tsconfig.json}`（CLI类型检查/lint入口）；校正尚未发布的 `packages/contracts/src/operator-security.ts` 及测试的多资源版本签发契约，必要时最小修改 schema 与本阶段新迁移以保存完整绑定；Test `apps/api/test/phase4/operator-security.e2e-spec.ts`。

**Interfaces:** Produces `OperatorActionContext = {actor: AuthenticatedUser; sessionId: string; deviceId: string; grantId: string}`；`ActionGrantService.consume(tx, context, binding): Promise<void>`，binding 精确包含 action/resourceId/expectedVersions/requestHash；`OperatorSessionService.assertCurrent(tx, context, capability): Promise<void>`。登录响应不返回设备 secret；服务器 CLI `approveDevice(deviceId, reason)` 只批准既有待批记录并审计。

执行裁定（2026-10-09）：尚未发布的签发 DTO 统一为严格 `expectedVersions/requestHash`，不增加旧单版本输入兼容；消费端按服务端规范化业务输入计算摘要。新增独立 POST `/api/admin/security/login` 及共享登录输入/结果承载绑定设备的 sid 会话，保留原无 sid 低风险登录行为；新增路由不接受客户端自行声明桌面能力。原因是 Task1 的单版本 DTO 不能表达本任务要求的完整动作绑定，既有 auth 返回又须保持兼容。

会话列表/撤销仅覆盖当前运营者自己的会话；不扩展跨账号单会话管理。受信 SUPER_ADMIN 撤销设备后，其绑定会话及授权立即失效。设备/会话修改使用持久化版本和 CAS，同事务递增、审计及幂等；不能以永远为1的版本代替检查。当前 sid 被撤销后，重试也必须先拒绝认证，不能因旧幂等结果绕过；可用同账号另一有效会话验证无重复撤销。

移动会话只批准紧急止损类 grant；`UNFREEZE_TRADING` 属于恢复，要求受信桌面，角色保留 REVIEWER/SUPER_ADMIN。`RESUME_ORDER` 要求桌面 SUPER_ADMIN。新增移动拒绝及桌面合法解冻的行为测试，不能让桌面能力替代角色授权。

- [x] **Step 1: 写失败测试。** `expect(await h.mobileGrant('APPROVE_FUNDS')).toMatchObject({status:403})`；伪造 User-Agent/deviceKind 不提升权限；密码重验后 grant 5 分钟过期，换资源/内容/账号拒绝；设备/角色撤销即时失效；审计失败不消费 grant；15/30 分钟边界测试。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/operator-security.e2e-spec.ts`，确认新安全入口/授权行为尚缺失。
- [x] **Step 3: 实现服务。** 设备登记生成随机绑定凭据，只存摘要，HttpOnly cookie（生产 Secure、受限 SameSite）；敏感会话必须携带有效 sid 和绑定 cookie，不接受客户端任意 deviceId。配置明确允许的运营 origin，跨域凭证/CORS/CSRF 校验不使用通配；开发本地例外仅非生产。移动默认权限、运维 CLI 首次批准、受信超级管理员非自批后续批准/撤销。旧无 sid token 只保留既有低风险查询/审核，不能获得第四阶段敏感权限。grant 绑定业务输入摘要（不含 grant 本身与密码），消费在业务事务内，成功幂等重试仍检查当前权限。CLI 执行只针对自有测试库，不对保留库自动批准。
- [x] **Step 4: GREEN。** 重跑 Step 2 和 `npm exec --workspace @barter/api -- vitest run --config vitest.config.ts test/auth-rbac.e2e-spec.ts`。测试辅助补齐 `operatorLogin`、`enrollOwnedDevice`、`grant`，走真实 API/受控 CLI，不给生产加测试授权后门。
- [x] **Step 5: 审查与提交。** `feat: add operator sessions and action-bound reauthentication`。

### Task 3: 工单创建、自有查询及基础处理状态

**Files:** Create `apps/api/src/after-sales/{after-sales.module,after-sales.controller,case-commands.service,case-reader,case.mapper,case-policy,after-sales.service,case-records.service}.ts`；Modify AppModule、OrderHoldService（保存多原因而非覆盖）；Test `apps/api/test/phase4/{cases,case-races}.e2e-spec.ts`。

**Interfaces:** Produces `AfterSalesService.open(actor, orderId, input, key): Promise<CaseCommandResult>`；`CaseCommandsService.run(context, mutate: (ctx: CaseMutationContext) => Promise<void>): Promise<CaseCommandResult>`；`readCase(tx, id): Promise<LockedCase|null>`；`CaseRecordsService.respond(context, input): Promise<CaseCommandResult>`；自有列表 `(createdAt,id)` 游标默认20最多50。

- [x] **Step 1: 写失败测试。** 两方同时 open 仅一份开放工单/暂停审计；同键同内容同结果，改内容409；非参与人404、混合角色403；`completedAt + 7天` 边界拒绝，时间不明返回明确人工核验结果而不猜。开户审计失败回滚工单、订单版本和幂等记录。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/cases.e2e-spec.ts test/phase4/case-races.e2e-spec.ts`。
- [x] **Step 3: 实现生命周期。** 读取权限先于缓存重放；OPEN/补证/回应/人工审核、拒绝方案原因、双方撤回请求与关闭；活跃风险或在途义务阻止撤回关闭，不自动恢复。CANCELLED 仅资金异常，终态订单不回退；已有 ON_HOLD 首次原因保留。关闭结果与后续根争议关联，避免重复处置。
- [x] **Step 4: GREEN。** 重跑 Step 2，验证原订单自有查询、暂停、验收禁止和 API 错误映射回归。
- [x] **Step 5: 审查与提交。** `feat: add participant after-sales cases and records`。

### Task 4: 私有证据上传、展示与原件审计

**Files:** Create `apps/api/src/evidence/{evidence.module,evidence.controller,evidence.service,evidence-storage.port,local-private-evidence.adapter,evidence-image-validator,evidence-cleanup.service}.ts`；Modify API package.json/lock（必要的图片解码依赖）、CaseRecordsService；追加 Prisma `EvidenceCleanupJob` 模型及新迁移（不修改已应用迁移）；Test `apps/api/test/phase4/evidence.e2e-spec.ts`、图片验证及清理故障测试。

审查兼容修正（2026-10-12）：文件部分写入和回收自身失败时，仅请求 finally 清理会丢失归属并覆盖业务结果。单次上传最多18个对象描述符在写入前持久登记；元数据成功事务同步结束登记，独立有界回收逐项查引用，失败保留重试且不改变原业务结果。OPEN 不按时间自动删除，仅在同主机/存储归属、确定上传已结束或原进程已退出时恢复；无法确定则保留人工核验。该内部清理补充满足原私有孤立对象要求，不提供生产本地存储回退或新的交易业务。

**Interfaces:** Produces `EvidenceUpload = {bytes:Buffer;contentType:string}`；`EvidenceService.appendCase(context, description, files: EvidenceUpload[]): Promise<CaseCommandResult>`；`appendReport(actor, reportId, input, files, key): Promise<RiskCommandResult>`；`read(actor, evidenceId, variant: 'preview'|'original'): Promise<{bytes:Buffer;contentType:string}>`。`EvidenceStoragePort.save/read/deleteOwned` 使用不透明键，不产生公开 URL。report 授权接口先定义，Task 7 接通。

- [x] **Step 1: 写失败测试。** 外人/无售后权限运营读404或403，客户不能读他人举报证据；9张通过、10张拒绝、累计31张拒绝；畸形JPEG/超像素/MIME伪造拒绝；展示无EXIF、原件摘要不变；原件下载审计失败不返回字节；无授权公开 URL 不可用。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/evidence.e2e-spec.ts`，图片解码测试须真实字节而非仅测试 mock。
- [x] **Step 3: 实现附件。** multipart 1～9张，正文与版本严格验证，幂等摘要包含文件内容摘要及次序。使用经过核对官方文档的 sharp 解码/像素限制与去元数据预览，保留原件；单批元数据与计数锁、审计同事务。新增依赖按实际锁定版本配置需要的 npm allowScripts，不升级整个技术栈。文件先写私有对象，失败对象标识有限范围清理；原件/预览响应 Cache-Control:no-store，下载逐次鉴权。缺生产私有存储明确503。
- [x] **Step 4: GREEN。** 重跑 Step 2、验证器测试以及原公开物品图片上传回归；断言私有证据从公开文件路由无法读取。
- [x] **Step 5: 审查与提交。** `feat: add private immutable after-sales evidence`。

### Task 5: 不可修改方案、客户确认与裁决记录

**Files:** Create `apps/api/src/after-sales/{resolution.service,resolution-policy,admin-after-sales.controller,admin-after-sales.service}.ts`；Test `apps/api/test/phase4/resolutions.e2e-spec.ts`。

**Interfaces:** Produces `ResolutionService.propose(operator, caseId, input, key): Promise<CaseCommandResult>`、`consent(context, input): Promise<CaseCommandResult>`、`adjudicate(operatorContext, input, key): Promise<CaseCommandResult>`；`resolveCompensation(input, originalDifferenceFen): NetCompensation`（Task 1类型），每项明示方向和非负金额，净额服务端推导。

- [x] **Step 1: 写失败测试。** 新版本使旧双方确认失效；两方仅自己确认；起草方案不代表用户验收；额外/运费20001拒绝、总净额60001拒绝，净零payer=NONE。EXECUTING 禁止直接换方案，终态订单方案不能倒退状态。必须回归修复 Task1 审查发现的数据库约束：REJECT 的理由不能接受 SQL NULL；通过真实 PostgreSQL 失败测试确认旧缺陷，再加新迁移约束并验证审计/裁决仍不可修改。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/resolutions.e2e-spec.ts`。
- [x] **Step 3: 实现五类方案。** OPEN 可直接进入 UNDER_REVIEW 后起草，无需虚构补证。校验物品快照属于该订单；每个原款目标由服务端计划推导，禁止任意收款账号和业务号。客服可起草/补证，风控不能越权裁决资金；裁决保存证据与理由，不虚构同意。CONTINUE_EXCHANGE 可含独立净补偿并保留原保证金及交换条款；安全恢复后可继续履约，但未结补偿阻止工单结案。执行入口在 Task 6 授权后接通，之前明确不能执行，不提交假成功。
- [x] **Step 4: GREEN。** 重跑 Step 2；验证方案、确认、记录不可修改触发器与新版本冲突。
- [x] **Step 5: 审查与提交。** `feat: add versioned after-sales resolutions and consent`。

### Task 6: 双人资金审批与方案执行授权

**Files:** Create `apps/api/src/after-sales/{resolution-approval.service,resolution-execution.service,resolution-executor.port}.ts`；Test `apps/api/test/phase4/resolution-approval.e2e-spec.ts`。

**Interfaces:** Produces `ResolutionApprovalService.approve(context: OperatorActionContext, caseId, input, key): Promise<CaseCommandResult>`；`ResolutionExecutionService.start(context, caseId, input, key): Promise<CaseCommandResult>`；`ResolutionExecutor.planInTransaction(ctx, resolution): Promise<void>`，具体义务由 Tasks 8～10 注册实现。不支持的执行类型明确拒绝，不把空执行器当成功。

- [x] **Step 1: 写失败测试。** 两名不同超级管理员批准后才执行资金方案，起草者、自批第二次、客服、移动会话均拒；grant后改版本/撤设备拒绝；审计失败回滚批准、grant消费和outbox；同键重试只一份执行记录。无资金CONTINUE仍需有权限且重新验证的恢复命令，不伪造资金审批。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/resolution-approval.e2e-spec.ts`。
- [x] **Step 3: 实现审批门禁。** 消费Task2grant；客户同意/平台裁决资格与资金批准分离。批准不可修改，判断当前方案、有效身份、不同批准者与非起草者；变更自动使旧批准不适用。执行唯一绑定case/resolution/step，原资金 UNKNOWN 阻止冲突执行。并发签发授权和业务动作统一锁序，审批通过不授予任意外部资金调用权限。
- [x] **Step 4: GREEN。** 重跑 Step 2、operator-security、resolutions。用客服起草、两个管理员批准；超级管理员起草测试增加第三个管理员 fixture，不降低非自批规则。
- [x] **Step 5: 审查与提交。** `feat: gate resolution execution with dual financial approval`。

### Task 7: 举报、交易冻结、单项下架与异常运单待办

接口补充（2026-10-15）：管理端先通过 `GET /api/admin/risk/users/:id` 读取仅含 status/version/reason 的限制投影。两个既定 clear-block 路由采用独立 CLEAR_ITEM_RISK/CLEAR_ORDER_RISK grant，受信桌面 REVIEWER/SUPER_ADMIN；订单清除输入指定 blockerId，不能恢复订单或清除无关阻塞。新增枚举仅用追加迁移，不改既有迁移。客户自有冻结提示读入口留 Task12。

审查修正契约：`GET /api/admin/risk-tasks` 及 `/:id` 返回可空 blockerId，仅暴露对应非终态订单上可合法解除的未解决风险阻塞；客户端经 HTTP 查询任务/阻塞及订单当前版本后构造 grant/清除请求。冻结后仍可重放已成功的同键同内容交易命令，限制行锁顺序保持，准入检查只针对新命令；新建提案的隐藏或冻结物主目标统一 ITEM_UNAVAILABLE，不暴露其限制状态。

**Files:** Create `apps/api/src/risk/{risk.module,risk.controller,admin-risk.controller,risk-report.service,trading-restrictions.service,risk-actions.service,risk-task.service}.ts`；Modify `apps/api/src/items/{items.service,public-items.service}.ts`、`apps/api/src/proposals/{proposals.service,proposal-order-handoff.service}.ts`、`apps/api/src/logistics/logistics-events.service.ts`；Test `apps/api/test/phase4/{risk-reports,trading-freeze-races}.e2e-spec.ts`。

**Interfaces:** Produces `TradingRestrictionsService.lockAndAssert(tx, userIds: string[]): Promise<void>`、`RiskTaskService.recordInTransaction(tx, input): Promise<void>`；`RiskActionsService.freeze/unfreeze/unpublish/pause(context, resourceId, input, key): Promise<RiskCommandResult>`（Task1类型）。`activeBlockers(tx, orderId): Promise<RiskBlocker[]>` 供恢复服务使用。

- [x] **Step 1: 写失败测试。** 公开物品/自有运单举报与匿名性；同目标同类开放举报去重；客服不能冻结；冻结与提案接受并发只有安全序列结果。冻结用户仍可登录、举证、退货；公开隐藏被冻结物主物品，解冻不自动恢复已下架物品。终态运单异常只追加待办。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/risk-reports.e2e-spec.ts test/phase4/trading-freeze-races.e2e-spec.ts`。
- [x] **Step 3: 实现风险闭环。** OPEN/INVESTIGATING/ACTIONED/DISMISSED、认领补证结论与证据访问；创建交易限制基线行确保不存在记录也可锁。新发布/提交、双方提案修改/接受、转订单均检查双方当前限制；限制行按ID先锁，不批量遍历订单。下架增加独立风险阻塞，不能用户编辑绕过；物品解禁后走重新审核。Shipment EXCEPTION 在事实事务中去重待办并暂停非终态，禁止把运营证明直接改成DELIVERED。
- [x] **Step 4: GREEN。** 重跑 Step 2、第一阶段发布审核、第二阶段提案并发和第三阶段物流异常回归；单项处置审计失败回滚。
- [x] **Step 5: 审查与提交。** `feat: add reports and transaction-safe trading restrictions`。

### Task 8: 多物归还义务、退货物流与私有地址

**Files:** Create `apps/api/src/returns/{returns.module,returns.controller,return-plan.service,return-commands.service,return-logistics.handler,return-events.service,return-address.service}.ts`；Modify LogisticsPort、SimulatedLogisticsAdapter/SimulatedProviderStore、IntegrationTypes/HandlerRegistry 注册处；Test `apps/api/test/phase4/returns.e2e-spec.ts`。

**Interfaces:** Produces `ReturnPlanService.planInTransaction(ctx, resolution): Promise<void>`；`ReturnCommandsService.registerShipment/handBack/confirmReceived(context, input): Promise<CaseCommandResult>`；`ReturnAddressService.get(actor, caseId, side: 'self'|'outgoing')`（Task1地址DTO）；`ReturnEventsService.applyVerified(event): Promise<void>`。LogisticsPort 扩展 verifyReturn/queryReturn/closeOrIntercept/queryInterception，都采用 ProviderOperation/ProviderResult；原接口不换签名。

- [x] **Step 1: 写失败测试。** 发起方5件/接收方1件逐件义务、合包无漏项；只一方交付不虚构另一方退货；注册原运单必须先核验拦截/关闭；面交交出与原物主确认不同角色；退货物流送达不自动确认；外人地址404，ON_HOLD 不因此开放原 outgoing地址接口。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/returns.e2e-spec.ts`。
- [x] **Step 3: 实现归还。** 原物主自己提供/确认加密归还地址，复用AddressCipher算法和AAD规范但隔离ReturnAddress身份；方案执行冻结地址，只有实际退回方在该归还义务合法执行时可读outgoing，泛化管理/幂等响应不含明文。快递覆盖snapshotID集合严格核验，运单全局不能复用原/其他退货单；独立ReturnShipment/Event。短事务outbox登记/核验拦截，未知结果不假设物品未交付。物流真实事实和客户确认分离，未归还异常留人工裁决。
- [x] **Step 4: GREEN。** 重跑 Step 2、原地址加密/泄露、原快递与面交回归；核验原Shipment不被覆盖、未知占用保留。
- [x] **Step 5: 审查与提交。** `feat: add item-level returns and controlled reverse logistics`。

**执行记录（2026-10-15）：** 实现提交 `9c1e7f1`，修复提交 `f058bcd`、`349192d`。第二轮 fresh spec/quality scoped re-review 均通过，R1 事件恢复缺口及 M1 测试路由注册偏差均已关闭。最终稳定树 `node .superpowers/sdd/2026-10-09-barter-after-sales-risk-implementation/local-postgres.mjs run npm run verify` 退出码0，979/979；Task8+Task6 专项72/72，Phase3 回归95/95；完整 verify 包含 lint、typecheck、test 和 build。已知迁移边界：只能回填升级时仍保存在模拟供应商成功结果中的事实；旧实现已覆盖且没有持久正文的历史事件不能凭空恢复。此项未实现真实物流/资金，也未提前实现 Task9/10/11。

### Task 9: 独立补偿支付、可信资金事实与原款退款

Task9 实施契约澄清（2026-10-22）：增加严格客户补偿摘要/checkout 契约、独立金融事实恢复器、内部原款执行授权；返回现有 CaseCommandResult，支付 ID 通过客户工单详情摘要读取。退货执行器组合调用两领域规划，START 的订单收尾留给 Task10。新增金融 operation enum 与 inbox 扩展采用追加迁移；金融与退货恢复器分别按事件类型消费，旧被覆盖历史不可恢复。无公开补偿取消命令，内部关闭/退款能力在缺合法授权转换时保持不可发送；未知及冲突继续阻止资金完成。此澄清不修改本任务完成勾选，完成状态由控制代理审阅后记录。

**Files:** Create `apps/api/src/compensation/{compensation.module,compensation.controller,compensation.service,compensation.port,compensation-outbox.handler,compensation-events.service,compensation-ledger,case-funds-status.service}.ts`；Modify `apps/api/src/integrations/{integration.types,simulated-provider.store,testing-integrations.controller}.ts`、`apps/api/src/payments/payment-outbox.handler.ts` 售后授权分支；Test `apps/api/test/phase4/{compensation,after-sales-financial-races}.e2e-spec.ts`。

**Interfaces:** Produces `CompensationService.planInTransaction(ctx, resolution): Promise<void>`、`requestPayment(context): Promise<CaseCommandResult>`、`getCheckout(actor, caseId, paymentId): Promise<CompensationCheckoutView>`；`CompensationPort.create/query/close/refund/queryRefund/disburse/queryDisbursement` 采用现有 ProviderOperation/ProviderResult。`CompensationEventsService.applyVerified(event): Promise<void>`；`CaseFundsStatus = {complete:boolean;unknown:boolean;conflicting:boolean}`、`CaseFundsStatusService.inspect(tx, caseId): Promise<CaseFundsStatus>`（定义在本任务并供Task10使用）。

- [x] **Step 1: 写失败测试。** 未审批不出款、裁决不主动扣客户款；净额60000通过/60001拒绝；退款与转付互斥、原差价不重复回转、原保证金无罚扣。乱序转付/退款事件先保存，收款到账后按原号补核验；外部成功但本地审计失败再次对账不二次执行；UNKNOWN始终保留占用。
- [x] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/compensation.e2e-spec.ts test/phase4/after-sales-financial-races.e2e-spec.ts`。
- [x] **Step 3: 实现独立资金域。** 新业务号 `compensation:payment:<paymentId>`、`compensation:refund:<paymentId>`、`compensation:disburse:<paymentId>` 全程稳定。引用方案/根争议/原支付、金额/币种/付款收款侧，独立账本唯一事实。原款退款沿用 `refund:<intentId>`，不改原PaymentPurpose唯一规则。对账可以入账既有外部事实，execute必须持合法且当前义务授权；处理并发authorize→I/O时间窗，记录在途执行认领，方案改动必须等待已认领业务核验。关闭/退款/转付状态互斥在模拟供应商和本地都保证；通用响应/幂等/审计不能保存checkout。测试驱动只在显式dev/test或acceptance H5启用，生产拒绝。
- [x] **Step 4: GREEN。** 重跑 Step 2、原订单支付/退款/结算、outbox lease与未知回调回归；断言同一根义务付款/退款/转付次数与金额守恒。若 CONTINUE_EXCHANGE 有独立补偿，未支付或转付 UNKNOWN 时 `CaseFundsStatus.complete=false`，不能报告工单资金义务完成。
- [x] **Step 5: 审查与提交。** `feat: add independently reconciled simulated compensation`。

**执行记录（2026-10-23）：** Task9 Steps 1–5 已完成，提交 `1d30cd55`。已观察真实 RED 后逐项实现；专项25/25、原资金回归118/118、完整Phase4 355/355；稳定树 `npm run verify` 退出码0，1004/1004，包含 lint/typecheck/test/build。两个新独立审查均通过，无 Critical/Important。非阻断测试建议带入Task10：对真实合法终止入口验证在途CLAIM保护；用已交付物品验证退货与补偿同时规划。三个API runner 固化 maxWorkers=2，依据默认并发下重复连接/迁移清理超时与限并发对照通过；未放宽超时或业务断言。金融事件使用独立持久inbox与原号恢复；旧被覆盖事件无法回填。任务级未新增界面，浏览器与六条独立阶段验收仍属于Task14。

### Task 10: 安全恢复、方案收尾与占用释放

**Files:** Create `apps/api/src/after-sales/{order-intervention.port,order-intervention.service,case-finalization.service}.ts`；Modify ResolutionExecutionService、订单/退款/归还事实通知、ReservationsService公开事务接口；Test `apps/api/test/phase4/{case-finalization,case-resume}.e2e-spec.ts`。

**Interfaces:** Produces `OrderInterventionService.resumeInTransaction(ctx, resolution): Promise<void>`、`extendDeadlineInTransaction(ctx, {kind,side?}): Promise<void>`；`CaseFinalizationService.reconcile(caseId): Promise<boolean>`、`reconcileInTransaction(ctx): Promise<boolean>`。订单快照、资金和归还结果通过公开读/事务端口获得，不直接调用第三阶段私有方法。

- [ ] **Step 1: 写失败测试。** 六件物品仅五件归还、资金未知或活跃风险存在时 `expect(await reconcile(id)).toBe(false)` 且全部原占用仍在；完整处理后仅释放本订单占用；终态订单售后不抢占后来订单。CONTINUE_EXCHANGE 安全恢复后可继续普通履约；若有独立补偿，未支付或转付 UNKNOWN 时工单保持非终态，不重复释放或反向暂停已安全恢复的订单；补偿可信完成后只结案一次。恢复由最新事实推导，不盲用holdPreviousStatus；延期同类第二次拒绝，新截止=服务器批准时间+72小时。
- [ ] **Step 2: RED。** `npm exec --workspace @barter/api -- vitest run --config vitest.phase4.config.ts test/phase4/case-finalization.e2e-spec.ts test/phase4/case-resume.e2e-spec.ts`。
- [ ] **Step 3: 接通五类执行与收尾。** Return/cancel全部义务完成才CANCELLED；交付过/质量争议物品INACTIVE，未交付且无风险安全取消恢复ACTIVE；KEEP要求每方自有独立“收到且保留全部物品”确认，不能把consent当acceptedAt，也不能运营代签，之后补偿+原结算完才COMPLETED。CONTINUE安全恢复可继续普通履约；无独立补偿且其他收尾义务已完成时结案，有独立补偿时工单保持开放直到收款和转付均由可信事实确认完成。FUNDS_ONLY不改旧终态。允许明确无法归还的裁决需证据、责任、已批准资金目标，标注“裁决处置”而非“用户确认归还”。风险仍有任何独立阻塞不解除；旧未知资金优先核验、已发外部指令不得撤销。完成状态、物品、占用、审计同事务；回调重入不重复结案。
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

- [x] **Step 1: 写失败浏览器验收。** 两用户争议→真实图片举证→客服退货方案→双方同意→两个独立桌面管理员审批→多物双向归还→整笔退款核验→结案；保留物品→独立确认→补偿模拟收款/转付→结案；移动冻结及桌面专属403、解冻/风险解除后受控恢复。断言旧物品未自动再上架、无二次付款、第三人无私有证据。
- [ ] **Step 2: RED。** `npm run e2e -- after-sales-returns.spec.ts after-sales-compensation.spec.ts after-sales-risk.spec.ts`；核实失败是尚未完成的跨端行为，不是手动migrate保留库或测试密码缺失。测试使用owner生成API运行时secret，不注入前端环境。
- [x] **Step 3: 完成验收准备与文档。** 仅在自有临时库seed第二管理员/客服/已审批设备，走Task2真实受控注册流程；账户密码由环境/owner提供，不硬编码真实凭证。owned库迁移兼容当前schema，旧legacy/phase3 runner仍通过；清理await服务关闭与普通DROP、catalog和源表/迁移对比。CI维持PostgreSQL17及六个独立门槛；失败上传trace而不上传运行时secret或私有证据原件。README明确两人审批、来源业务号核验、桌面能力不是物理/MFA、生产缺外部适配器不可上线，AGENTS补读本阶段spec/plan和不能自动终结售后的规则。
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

设计及计划：用户于2026-10-09确认。实施准备：当前分支干净；用户明确选择沿用现有工作区；Docker daemon 未启动，使用新建、仅监听本机的 PostgreSQL 17 临时验证集群，不修改原保留业务库。Tasks 1～7 已完成，Tasks 8～14 尚未完成；最终六条门槛仍待阶段末独立执行。执行方式沿用子代理逐任务开发与独立审查。

### Task 1 实际结果

- 提交：`238be4e`（共享契约、持久化及测试底座）；`c5a65a8`（审查后补齐资金持久化校验）。
- RED：新契约初始20项、新模型初始6项失败，原因均为缺少实现；审查修正新增35项中11项失败，复现空 JSON、缺失/错误回转来源及旧事务快照下两个资金终态共存。
- GREEN：契约66项；候选 `238be4e` 全仓 `npm test` 642项退出0。修正后 Phase4 专项48项通过，最终新用例文件39项通过；历史迁移兼容1项、API lint/typecheck退出0。642项不是修正后的全仓结果，未混用证据。
- 两位独立代理分别审查需求及质量，发现三项 Important；原实现代理修正后，两位新的独立 scoped 复查代理均确认全部已处理、无新增阻断问题。
- 原三份历史迁移未改；各阶段测试源库表计数/迁移记录不变、归属临时库全部清理。该证明不是源数据逐行快照。没有 reset、强制 DROP、SQLite 或真实外部资金业务。
- 普通 Git 行尾提示仍有记录，不是测试 warning。Task5 已用真实 PostgreSQL RED/GREEN 修复 REJECT 理由为 SQL NULL 时 CHECK 三值逻辑放行的问题；旧持久化测试的前序数据依赖留整分支审查核对。
- 兼容性裁定：`applyMigrations` 默认仍执行所有当前迁移，仅历史三迁移测试显式指定数量3；Phase4 复用经过清理验证的 Phase3 归属库工具及订单 HTTP 测试流程。

### Task 2 实际结果（2026-10-10）

- 产品提交：`d322260`（运营会话、设备及动作授权）；`39279d1`（完整分页、永久首次初始化边界）。中间文档澄清提交：`3eb8a1d`、`d7e7a75`、`47ab8b5`、`3e785b5`。
- 新 sid 登录、随机设备绑定、当前权限重读、15/30分钟会话、5分钟单次完整版本/内容授权；设备/本人会话版本、同事务审计及幂等，精确Origin及生产Secure/HttpOnly/Strict-cookie。保留旧无sid低风险路径，无匿名批准和客户端自授桌面能力。
- RED：缺少路由4项、完整签发契约1项、撤销版本及误传非事务客户端、移动解冻2项都实际观察失败。首轮全仓失败为旧固定迁移总数4/实际5，已改为历史三迁移name/checksum/finishedAt保留和回填迁移存在；不改原迁移。
- GREEN：原候选最终全仓 `npm test` 702项退出0；旧auth11项、最终专项28项及API lint/typecheck通过。独立审查修正后安全文件28项、共享契约3项及API lint/typecheck通过；702不是修正后的全仓结果。测试库隔离/普通清理证明均通过，未操作保留库。
- 两项独立审查发现分页缺失和bootstrap全部撤销后重开，两位新的独立复查代理确认均修正、无新增阻断。真实HTTP分页覆盖57条和相同时间、默认20/最多50、无重复遗漏/跨账号隔离；真实CLI验证永久关闭、审计失败首次重试和并发仅一次。
- 原非阻断压行问题留整分支审查；弱隐私断言已加强；Git行尾提示保留说明。Cookie同站部署约束、非硬件/MFA能力不能隐去。全部受信设备丢失后没有自动恢复入口，第五阶段另需明确安全恢复机制。

### Task 3 实际结果（2026-10-12）

- 提交：`18c8d3d`（参与人售后工单及不可修改记录）；`bf9467f`（异常历史链核验和关联待核验事实保护）。
- 独立售后模块提供自有创建/分页/详情、指定补证与回应、双方撤回、独立管理查询/基本驳回。当前权限先于幂等重放，订单先于工单加锁，双版本/状态/审计/记录/缓存同事务。首次暂停原因保留，关闭不恢复订单或释放占用，终态售后不抢后来交易。
- RED：初始12项缺路由；后续实际复现跨订单同键500、无关退款放行、前序关联误选、同根风险/未完成义务漏查以及详情混合快照。原详情版本硬编码测试不能证明缺陷，已替换为主行/时间线读取间真实HTTP并发写入。完成义务允许关闭也有实际RED/GREEN，未伪造其他领域完成事实。
- GREEN：候选全仓 `npm test` 744项退出0（脚本12/admin29/API137+261+110/mini128/contracts67），发生于最终独立管理投影调整前；调整后专项34、契约11、API lint/typecheck通过。原订单专项58项通过。744不是审查修正后全仓结果。
- 两项独立审查发现Important：非空导入历史零链尾误建新根；同根补偿/退货待核验事件未阻关闭。修正新增8类异常历史及33类外部事实测试，均先观察真实失败。最终三文件75项、API lint/typecheck通过；两位新的独立scoped复查均确认已处理、无新增阻断问题。
- 所有测试迁移及清理限自有临时库，源库计数/迁移记录不变、临时库普通清理并核验catalog，不宣称逐行源数据一致。没有新迁移、schema/依赖变更、真实业务或推送。Git行尾提示保留记录；短暂模型容量错误恢复后接续原测试，未重复启动。
- 后续门槛：Task5接真实方案拒绝，Task8/9/10证明归还/资金完成事实写入及同订单锁协议，Task11接通共享请求/定时过期。当前只读这些事实，不伪造执行；交易冻结本身不阻断必要售后，具体风险关联留Task7。

### Task 4 实际结果（2026-10-12）

- 提交：`3ab1705`（私有证据上传与读取）；`2fd5c26`（审查修复所需的有界、可恢复清理契约）；`babe6a6`（持久化并发回收任务、所有权围栏及失败保留）。最终审查记录：`8893897` 为本任务 BASE，修复范围 `3ab1705..babe6a6`。
- 图片采用 sharp 0.35.5 解码；私有原件与去元数据预览无公开 URL，逐次检查当前身份/权限，原件审计与读取受控。实际图片字节和 PostgreSQL 元数据测试覆盖限额、越权、重放、回滚、私有存储缺失时503；该环境没有生产对象存储适配器。
- 修复前真实 RED：部分字节写入后 EIO 留下文件；首次删除错误导致 HTTP 409 被覆盖成500且停止后续清理；引用查询失败导致已提交 HTTP 200 被覆盖成500。修复加入仅新增迁移 `20261012160000_private_evidence_cleanup_jobs`：先持久登记最多18个对象，独占创建后、写字节前确认所有权；元数据事务与READY围栏同事务；引用查询/逐项删除错误保留可恢复描述符且不覆盖原业务结果。OPEN 任务不按时间清理，只有原实例确认请求结束或同主机记录进程明确不存在才恢复；无法证明的对象留待核验。
- 修复后专项：清理/证据测试25项通过，证据单测及旧公开上传回归24项通过，共享契约17项通过，API lint/typecheck通过。候选 `3ab1705` 的全仓 npm test 为809项通过；此全仓结果属于修复前候选，不作为 `babe6a6` 的全仓验证。本任务修复后没有重跑全仓套件，阶段末六项门槛仍待执行。
- 独立规范复审通过，确认原有重要问题均修正、无新增问题。独立质量复审批准并记录一项非阻断 Minor：其他实例删除READY任务后，原实例的进程内 `ended` 集合可能留有无用UUID；不影响持久回收或业务结果，交由最终整分支审查处理。原两项Important（部分写入归属丢失、清理失败覆盖业务结果/遗失后续对象）均有真实失败复现和修复后测试证据。
- 迁移只新增清理任务表，没有改写既有迁移。测试证明限定源库表计数/迁移记录及临时归属库清理，不宣称源数据逐行相等；仅使用私有本地临时PostgreSQL，未用SQLite或真实外部服务。

### Task 5 实际结果（2026-10-12）

- 提交：`ed29a7f`（不可修改方案、客户确认与裁决）；`6412286`（最终裁决审计失败后的真实事务回滚覆盖）。独立复审范围：原候选 `5f147d7..ed29a7f`；修复 `ed29a7f..6412286`。
- 建立五类不可修改方案、逐参与方当前版本同意/拒绝、独立超级管理员裁决和严格管理端方案上下文。所有资金目标/金额方向/净额/订单结果由服务端从锁定事实推导并校验客户端主张；不生成资金执行、订单恢复、物品验收、批准或虚假成功。仅新增迁移 `20261012170000_resolution_consent_reason`，显式拒绝 REJECT + SQL NULL，既有已应用迁移及不可修改历史未被改写。
- 方案管理视图只返回已允许的物品快照、侧别/履约状态及确认资金事实，不含用户标识、地址、checkout、凭据或原始外部数据；客户详情不包含该上下文。CONTINUE_EXCHANGE 可同时约定独立净补偿，原保证金和交换条款保持不变；补偿仍待后续审批、执行和可信事实。
- RED/GREEN：初始有效 PostgreSQL 运行 7/8失败，其中原始SQL插入 REJECT+NULL 成功证实约束缺陷；缺少路由为404。扩展11项中10项失败，覆盖裁决权限与投影。新增管理上下文和 CONTINUE+400分方案也各自先观察RED；修复后方案专项21/21，Phase4 API全套195/195，契约专项15/15通过。最终候选 `ed29a7f` 全仓843/843；审计修复后最终全仓844/844（root12/admin29/API146/Phase3 API261/Phase4 API198/miniapp128/contracts70）。最终API lint、API typecheck、contracts typecheck与diff-check均退出0；契约工作区没有独立lint脚本。
- 审查：初始独立规范复审通过；质量复审提出一项非阻断的最终业务审计回滚测试缺口，新增真实 audit INSERT 后故障、完整事务状态快照回滚及同grant/key重试/重放。两位新的 scoped 复审代理确认该问题已解决、无新增Critical/Important/Minor。CONTINUE补偿结案条件也已同步写入本设计及Task9/10计划：普通履约可继续，但补偿和转付未核验完成时工单保持开放。质量复审指出的 earlier spec minor已在公共文档中明确修正。
- 每次 PostgreSQL 验证使用自有命名空间与普通清理；报告证明源表计数/迁移记录不变、测试库清空，不宣称逐行/逐字节源数据相等。完整候选全仓测试存在一次与最后两处修改重叠的失败运行，已原样记录；稳定代码上的最终完整运行844/844退出0，未把重叠运行称为通过。无真实资金/物流服务、SQLite、历史迁移改写、推送或合并。

### Task 6 实际结果（2026-10-15）

- 提交：`c156dce`（双人资金审批及执行授权）；`47edfcd`（并发身份权限围栏与历史运单异常门禁修复）；本任务完成记录另行提交。
- 资金执行批准绑定当前不可修改方案版本；不同、具备当前有效凭据的超级管理员共同批准，起草者不得自批，客服与移动会话不具备执行权。执行记录、grant消费、事务计划、审计和幂等结果共用业务事务；不支持的执行类型明确失败，不调用真实外部资金服务。
- RED：初始18项中3项失败，分别暴露历史运单EXCEPTION永久阻断补救执行，以及执行规划期间批准者角色/凭据撤销可竞态提交。修复加入事务内、稳定排序的用户/角色/凭据共享锁与重读资格；另测角色撤销先提交时拒绝执行且不消费授权。历史EXCEPTION事实保持不变，只要求独立活动风险及未解决阻塞已清理。
- GREEN：修复后相关三套测试69/69；最终完整 `npm run verify` 退出0，863/863测试通过，并通过lint、typecheck和所有workspace build。测试包含PostgreSQL实锁和规划屏障：证明执行先获得审批围栏时撤销等待提交、撤销先提交时执行失败回滚，以及不同执行人竞争仅一个获胜。可信签名 COURIER 异常后送达事件覆盖历史异常事实保留及补救门禁恢复。无状态库替换或真实外部业务调用。
- 两份独立 scoped 修复复审均 PASS：原两项 Important 均 ADDRESSED，未发现新的 Critical/Important/Minor。范围为 `c156dce..47edfcd`。复审确认角色撤销/凭据撤销/账户禁用在事务内受到身份行围栏；实现不声称防护任意外部 SQL 人为插入此前不存在的 CUSTOMER 角色，这一限制已记录，未来角色管理入口须纳入同一围栏协议。质量报告中的全仓结果为实现代理记录，复审者未重复运行。
- 测试库归属/清理及Phase4隔离证明均通过；未修改既有迁移或依赖。候选 `c156dce` 的初始复审发现及修复过程见 `.superpowers/sdd/2026-10-09-barter-after-sales-risk-implementation/task-6-report.md` 与独立审查记录。全仓六项阶段门槛仍须 Task14 最终执行。

### Task 7 实际结果（2026-10-15）

- 提交：`8ed974c`（举报、交易冻结、单项下架与异常运单待办）；`4469db5`（修复风险阻塞标识可读、冻结后成功命令幂等恢复及隐藏目标隐私问题）。原候选全仓 `npm run verify` 为895/895；审查修正后稳定树全仓验证为925/925，lint、typecheck与所有workspace build均通过。修复专项60/60；受影响第一至第三阶段遗留回归38/38。原候选另有第一/二阶段回归52/52、第三阶段回归68/68。
- 举报公开物品/参与人运单，执行身份、当前目标可见性、严格去重、匿名安全投影及私有证据授权；审核风控/超级管理员执行认领、补证和有证据结论。账号冻结使用独立版本化交易限制行，不禁登录或售后读取、不批量改写物品/订单；公开列表即时隐藏冻结物主的物品。限制行按参与人 ID 排序并先于物品/提案/订单锁取得，冻结竞态使用真实 PostgreSQL 阻塞观测测试。
- 单项下架建立独立风险阻塞；解除后物品仍为 INACTIVE，物主需编辑、重新提交并通过常规审核。订单风险解除只清除经来源校验的单一风险阻塞，不自动恢复订单或清理工单/物流等无关阻塞。授权管理查询仅返回当前用户限制摘要；风险任务列表/详情只在非终态订单、受支持且未解决任务与匹配的开放风险阻塞时给出确切 blockerId，终态/已解决/错误关联不返回可操作标识。
- 交易限制检查和限制行锁分离：先按稳定顺序锁限制行、再锁业务资源并完成身份/参与方核验；命中同一调用者同键、同内容的既有成功记录时允许恢复原响应、不重写状态或审计。新命令仍拒绝冻结参与者；错误内容/资源/用户不能取回旧响应。创建新提案对不存在、不公开、冻结物主的目标统一 `ITEM_UNAVAILABLE`，且在等待限制锁后重新核验目标状态，避免利用错误码探测私有物品或物主冻结状态。
- 可信 Shipment EXCEPTION 在事实事务内幂等写入风险待办；仅非终态订单增加独立风险阻塞/暂停，原暂停原因保留，终态只新增待办且不回退状态。后续签名 DELIVERED 可补充送达事实但不抹去 EXCEPTION；运营不能直接写运单进度。终态异常待办目前可供授权风险人员查看，后续结案写操作未在 Task7 发明，留为显式产品决策。
- 初始候选独立审查发现3项 Important：清除风险阻塞所需 blockerId 未通过任何管理只读投影暴露；冻结检查在幂等重放前导致成功命令无法恢复；创建提案会对不可见物品泄露物主被冻结状态。修复逐项先观测 RED 后实现，增加 HTTP-only blocker查询/清除、五类命令冻结后恢复及不同参与人覆盖、隐藏目标和冻结等待竞态测试。两位新的 scoped 修复复审均 PASS：三项发现全部 ADDRESSED，差异内无新增 Important/Critical；范围 `8ed974c..4469db5`。首轮与修复轮完整报告见 `.superpowers/sdd/2026-10-09-barter-after-sales-risk-implementation/task-7-report.md` 和独立审查报告。
- 新增迁移仅为 `20261015190000_risk_clearance_actions` 枚举追加清除授权，不改既有迁移或依赖。阶段验证数据库仅限自有 PostgreSQL 17 名称空间、普通清理及catalog/count/migration证明，不宣称源数据逐行一致；图片测试清理仅处理本套件自有临时目录。没有 SQLite、reset、强制 DROP、真实外部服务、秘密、推送或合并。
- 仍未覆盖/不声称完成：实际归还 API 属 Task8；订单恢复属 Task10；终态异常待办的结案产品决策未制定；用户/运营界面分别属 Tasks12/13；浏览器流程与阶段六条最终门槛属 Task14。

### Task 14 实际结果

- 工作树交付：`e2e/support/after-sales.ts`、`e2e/after-sales-{returns,compensation,risk}.spec.ts`；seed 第二超级管理员；acceptance 第三客户码；`prepare-e2e` 注入 `LOCAL_PRIVATE_EVIDENCE_DIR`/`OPERATOR_ORIGINS`；README/AGENTS/CI 注释与 `docs/superpowers/reviews/2026-10-09-phase4-final-review.md`。
- RED/GREEN：本地 `npm run e2e -- after-sales-returns.spec.ts after-sales-compensation.spec.ts after-sales-risk.spec.ts` **未全绿**。compensation 用例 600000ms 超时且停留在运营登录页；returns 在中断后出现 browser closed；risk 未完成。日志 `/workspace/task14-e2e-after-sales.log`，上下文 `/workspace/task14-review/`。
- 六条门槛：本 Task14 会话未在 tip 上声称全绿；不得把未跑通的 e2e 标成通过。`npm run build` 在整理前曾成功（见 `/workspace/task14-build.log`），不替代 verify/e2e。
- 整分支审查：见 `docs/superpowers/reviews/2026-10-09-phase4-final-review.md`，结论 **Phase 4 不可宣告完成**；售后跨端验收需修复后重跑。
- 推送/PR/merge：由用户授权后的父代理执行；本执行器不 push。

### 2026-10-26 登录与售后浏览器验收补记

- 运营登录失败不是表单没提交。设备页在只有密码会话时请求设备/会话列表，`REAUTH_REQUIRED` 被管理端当成登录过期并清掉 `barter-admin-session`，Playwright 一直停在「运营审核登录」。修复：未绑定 sid 时不拉列表；`REAUTH_REQUIRED` 不清除低风险密码登录；同一请求里完全相同的设备 cookie 算一份凭证。首次桌面批准仍是一次性 CLI，后续用例用权限 0600 的临时 cookie 文件复用，只写当前 owned 库名。
- 退回原物用例在两件物品时，确认按钮在退货列表画出来之前被数成 0，第二件义务留在已送达，两笔原款退款因此一直未授权。确认循环改为等「持有」义务行出现后再点下一枚按钮。
- 本地 PostgreSQL 16.15（CI 为 17）。`npm run e2e -- after-sales-compensation.spec.ts after-sales-returns.spec.ts after-sales-risk.spec.ts` 为 3 passed（约 4.2 分钟），隔离证明通过。全量 `npm run e2e` 为 10 passed / 1 failed：失败在 `listing-review.spec.ts` 客户提交物品，页面告警 `upload is not defined`，发生在运营登录之前，与本次登录修复无关。`npm run verify` 通过；miniapp H5 构建有既有的 vendors.js 体积和 code-splitting 警告。不把全量 e2e 标成通过，也不宣告 Phase 4 完成。
