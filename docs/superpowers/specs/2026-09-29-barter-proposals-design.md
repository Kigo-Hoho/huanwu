# 第二阶段：投物箱与协商设计

本设计落实 2026-09-29 第二阶段实施计划。第一阶段物品发布与审核保持原有行为；本阶段开放公开物品发现、结构化投物、轮流协商和限时独占占用。总体设计中的订单、支付、履约、聊天和售后仍属后续阶段，本阶段接受不会生成订单或扣款。

## 身份、发现和权限

继续共用 NestJS API、PostgreSQL/Prisma、`@barter/contracts`。普通用户使用微信身份，运营使用独立运营会话。所有提案写接口要求 CUSTOMER 会话；任何运营角色均不得通过普通用户命令冒充参与人。

`GET /api/items` 和 `GET /api/items/:id` 只返回 ACTIVE 物品。公开视图明确选择物品内容、图片、物品与所有者标识、版本、UTC 创建/更新时间和 `availableForProposal`，排除拒绝原因、微信标识及其他私有数据。已占用物品仍可浏览，可投标识为 false。列表默认 20 条，按 `(createdAt DESC, id DESC)` 稳定游标分页，响应 `{ items, nextCursor }`，末页 `nextCursor=null`；游标携带排序键，非法游标返回 400。详情不存在或不公开统一返回 `ITEM_NOT_FOUND`。

提案详情和用户列表仅参与者可见；非参与人读取返回 404。运营列表、详情是独立只读接口，允许 OPERATIONS、REVIEWER、SUPER_ADMIN，不提供任何代出价操作。

## 方案与金额契约

发起方 INITIATOR 提供自己 1～5 件已上架物品；接收方 RECIPIENT 提供自己恰好一件目标物品。总计 2～6 件且不重复，双方必须不同。创建请求包含 `offeredItemIds`、`targetItemId` 及完整条款；接收人从目标物品所有权推导，不接受调用方指定参与身份。

条款为 `differenceFen`（0～20000 整数分）、`payer`（NONE/INITIATOR/RECIPIENT）、`deliveryMode`（COURIER/IN_PERSON）、`initiatorShippingFen` 和 `recipientShippingFen`。差价为零必须 NONE，非零必须指定付款侧；运费为各方自行承担的非负整数分估计，最大值为 PostgreSQL Int 上限 2147483647。面交运费均为零。这里的金额仅记录约定，不代表收付款。

Counter 使用完整方案字段加 `expectedVersion`。服务端对比现版：发起方只能改变 `offeredItemIds`，接收方只能改变 `targetItemId`；另一侧物品必须保持一致。双方均可改差价和运费条款。每次 counter 形成完整新快照；不依赖前一版本增量恢复。

所有写命令要求非空、最长 200 字符的 `Idempotency-Key`；创建之外都要求正整数 `expectedVersion`。未知命令字段拒绝。服务端先验证会话、身份和参与权限，再查重；同 actor/command/key 与同请求内容返回原始成功结果，包括已变化的状态和期限之后的重放，不再次改变业务。键相同内容不同返回 409 IDEMPOTENCY_CONFLICT。内容哈希包括规范化请求和目标提案 ID；规范化须稳定排序对象字段，物品顺序作为快照展示顺序保留。与原始成功写入同时保存 response、requestHash；现有第一阶段幂等记录 requestHash 允许为空，第二阶段所有新记录必须有哈希。

## 状态机、版本与期限

`Proposal.version` 是乐观并发修订号，每次成功状态转换递增；`currentVersion` 是当前报价编号，仅出价时递增。初始均为 1。不可变 `ProposalVersion.number` 在一份提案内唯一。最新报价作者已经表达同意，当前 responder 接受该报价表示双方对该版达成一致；不存在跨版本沿用的确认。

| 当前状态 | 命令/条件 | 执行者 | 结果 |
| --- | --- | --- | --- |
| 无 | create | 发起用户 | PENDING，轮到接收方，7 天期限 |
| PENDING | counter | 当前回应方 | 新报价，轮到对方，重新计 7 天 |
| PENDING | accept | 当前回应方 | CONFIRMED，全部物品独占 72 小时 |
| PENDING | reject | 当前回应方 | REJECTED |
| PENDING/CONFIRMED | cancel | 任一参与者 | CANCELLED，释放全部占用 |
| PENDING | 当前时间 >= expiresAt | 系统 | EXPIRED |
| CONFIRMED | 当前时间 >= reservationExpiresAt | 系统 | EXPIRED，释放全部占用 |

已终止状态不再报价或接受。到期边界使用服务端时间；API 时间统一 UTC ISO 8601，客户端时钟无权决定期限。待回复 expiresAt 保留最后出价期限；确认后使用 reservationExpiresAt，confirmedAt 记录接受时刻。终止时保留这些历史时间，不清空快照。

状态转换集中于提案服务；请求时到期检查和周期任务调用相同的到期转换方法。自动到期审计使用系统 actor（null）并保存原因和前后状态。请求先完成必要的到期转换再返回错误，不能因抛出业务错误而把到期处理回滚。未经到期清理的旧占用不能被直接覆盖。

## 原子占用与事务

接受在一个 PostgreSQL 事务内重新读取并校验参与者、回应轮次、expectedVersion、期限、最新方案、每件物品所有权/ACTIVE 状态和有效占用。对提案采用条件更新或行锁；物品按 ID 排序锁定并重新校验。成功写状态、全部 2～6 条占用、幂等结果和不可变审计；任一失败整笔回滚，返回明确 409。

`ItemReservation.itemId` 为主键，数据库保证同物品只能有一条当前占用。不同未确认提案可以复用物品。取消或到期通过相同转换服务在事务中删除对应占用行，审计及历史报价保留。数据库唯一冲突转换成 ITEM_UNAVAILABLE；重试前重新检查幂等记录，禁止把数据库错误当作部分成功。服务端必须核验 reservation 的 proposalId/proposalVersionId 和当前方案对应关系。

第三阶段须在 72 小时占用期内原子地把确认方案转换为订单。本阶段没有转换接口；到期不会自动生成订单。

## 持久化与历史

- Proposal 保存参与者、当前回应人、状态、并发修订号、当前报价编号和期限。参与者不能相同；回应人只能是参与者之一。
- ProposalVersion 保存作者、编号、完整差价/配送条款与创建时间，`(proposalId, number)` 唯一。
- ProposalVersionItem 保存物品 ID、当时 ownerId/itemVersion、归属侧和显示顺序，以及标题、描述、成色、估值分、想换文本和有序图片 URL 数组。读取历史无需 JOIN 当前物品内容。引用 Item 使用 Restrict，历史物品不可物理删除。
- PostgreSQL 触发器拒绝版本和快照行的 UPDATE/DELETE。每个版本及全部快照必须在同一创建事务中插入；后续服务不得向旧版追加物品。每侧数量、所有权、作者与报价归属由服务端验证；数据库额外保护不重复物品、每侧显示位置和金额边界。
- ItemReservation 只保存当前占用及到期时间；历史通过方案与审计恢复。
- IdempotencyRecord 延用 actor/command/key 唯一约束并新增 requestHash，不改变第一阶段提交语义。

所有敏感转换必须与 AuditLog 在同一事务内记录；审计失败回滚业务、占用和幂等记录。应用不得提供历史修改或审计删除接口。

## 接口与错误

| 接口 | 用途 |
| --- | --- |
| POST /api/proposals | 发起投物 |
| GET /api/me/proposals?direction=sent\|received | 当前用户发出/收到 |
| GET /api/proposals/:id | 参与者详情与完整历史 |
| POST /api/proposals/:id/counter | 新报价 |
| POST /api/proposals/:id/accept | 接受并占用 |
| POST /api/proposals/:id/reject | 拒绝 |
| POST /api/proposals/:id/cancel | 取消并释放 |
| GET /api/admin/proposals | 运营只读列表 |
| GET /api/admin/proposals/:id | 运营只读详情 |

命令返回 ProposalView；其 `versions` 按 number 升序包含完整不可变版本，当前编号为 currentVersion。每版含 offeredItems、targetItem 和完整条款。列表可直接使用该视图，后续若增加摘要契约须同步共享类型。

任务 3 已实现创建（201）、用户列表和参与者详情（200）。用户列表要求显式 `direction=sent|received`，按 `(createdAt DESC, id DESC)` 返回完整 ProposalView 数组。创建时物品不存在、归属不符、自投、非 ACTIVE 或存在未到期占用均返回 409 ITEM_UNAVAILABLE；过期占用与公开可投标识一致，不阻止新的待回复提案，也不会被创建操作删除或覆盖。协商命令、占用和自动期限处理由后续任务实现。

任务 4～5 已实现 counter、accept、reject、cancel（成功 200）。所有命令先锁定并重读提案，核验参与身份后再查幂等记录；新命令校验期限、并发修订号、状态和回应轮次。counter 对另一侧有序物品 ID 做完整一致检查，并锁定、重新验证双方物品后创建独立完整快照。accept 按物品 ID 排序加锁，重新核验最新方案的双方归属、ACTIVE 状态与占用，原子写入全部占用、CONFIRMED、PROPOSAL_CONFIRMED 审计和幂等响应。已确认取消原子释放全部占用。

每 60 秒执行一次到期扫描，参与者详情/列表读取和过期写命令也使用同一个 expire 转换。写命令回滚后独立提交到期转换，再返回 409 PROPOSAL_EXPIRED，避免错误响应回滚清理；已 EXPIRED 的新命令同样返回该错误。扫描使用行锁重新验证期限，重复扫描不重复审计。接受遇到旧的过期占用时，先释放当前事务的锁，再对原提案完成审计到期清理后重新尝试接受，禁止直接覆盖旧占用并避免反向提案锁死锁。到期审计失败保留原状态和占用，后续扫描重试。公开可投标识按占用时间直接计算，不等待扫描。成功命令的幂等重放仍返回原始成功响应。

400 VALIDATION_FAILED 表示不合法请求或缺失幂等键；401 AUTH_REQUIRED；403 FORBIDDEN 表示会话角色或参与权限不足，PROPOSAL_WRONG_TURN 表示非当前回应人，PROPOSAL_SIDE_FORBIDDEN 表示越侧修改；404 PROPOSAL_NOT_FOUND 隐藏非参与者提案。409 包括 PROPOSAL_VERSION_CONFLICT、PROPOSAL_INVALID_STATE、PROPOSAL_EXPIRED、ITEM_UNAVAILABLE、IDEMPOTENCY_CONFLICT。错误仍统一 ApiErrorBody，并带 requestId。

## 测试身份与分任务交付

API 仅在显式 `WECHAT_IDENTITY_PROVIDER=acceptance` 且 `NODE_ENV=test` 时选择测试提供器。保留 `e2e-customer-code` → `local-seed-customer`，新增 `e2e-customer-two-code` → `local-seed-customer-two`；其他代码拒绝。首次登录沿用 AuthService 创建 CUSTOMER，不需要生产微信或运营账号。正式环境使用真实微信，不变更生产配置。前端双浏览器会话/测试选择入口在后续端到端任务实现。

任务 1 仅交付契约、数据模型、迁移和测试身份，不注册提案接口。任务 2～7 分别交付发现、创建/查询、协商、原子占用、工作台和两用户验收。任务 4 的接受操作在任务 5 完成原子占用前不能对外成功返回 CONFIRMED。

验证覆盖契约数量/金额/方向/版本/UTC、两身份独立性、不可变快照、唯一占用、服务端权限、并发、幂等、审计失败回滚及延迟定时任务。最终浏览器流程为发现 → 多物投物 → 对方替换目标并修改条款 → 发起方接受 → 物品不可投 → 取消释放。
