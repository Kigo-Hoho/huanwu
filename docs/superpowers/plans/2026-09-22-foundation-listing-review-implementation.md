# Foundation and Listing Review Implementation Plan

Phase 1 remains the completed publishing/review baseline. Phase 2 proceeds under [the proposal implementation plan](2026-09-29-barter-proposals-implementation.md); its contracts and persistence do not add proposals to the Phase 1 scope or create orders/payments.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working vertical slice in which a WeChat user creates and submits an item, an authorized operator reviews it from a responsive web workspace, and every state change is permission-checked and audited.

**Architecture:** Use an npm-workspaces TypeScript monorepo with a Taro user miniapp, a React and Ant Design operator web app, a NestJS REST API, a shared contracts package, and PostgreSQL through Prisma ORM. Keep identity providers, storage, and later payment or logistics integrations behind ports so the first slice can run locally without external credentials.

**Tech Stack:** Node.js 24.15 or newer, npm workspaces, TypeScript, Taro 4 with React, React with Vite and Ant Design, NestJS, PostgreSQL 17, Prisma ORM 7, Zod, Jest and Supertest for the API, Vitest and Testing Library for frontends, Playwright for the browser acceptance test.

**Spec:** `docs/superpowers/specs/2026-09-22-barter-miniapp-dual-workbench-design.md`

## Global Constraints

- The MVP supports item-for-item exchange and item-plus-small-cash-difference only; it does not support cash-only purchases.
- The user miniapp and operator workspace use one REST API and one source of shared contract types.
- The operator workspace is a responsive web app; do not create a separate operator miniapp in this phase.
- Operators act through explicit management commands and never impersonate normal users.
- Every review, rejection, unpublish, freeze, and permission-sensitive action must create an immutable audit record.
- Authorization is enforced in the API. Hiding a frontend control is not an authorization mechanism.
- Monetary values are integer fen. Timestamps are UTC ISO 8601 strings at API boundaries.
- Do not add payment, logistics, exchange-proposal, order, or after-sales implementation in this phase.
- Commit `package-lock.json` and pin installed dependency versions through it.

## Review Focus

- A user requesting or modifying another user's draft receives `404`, and Task 5 pins this behavior with an API integration test.
- Two reviewers acting on the same item version cannot both succeed; Task 6 pins the second action to `409 ITEM_VERSION_CONFLICT`.
- Repeating an identical submit command does not create duplicate audit entries; Task 5 pins command idempotency.
- An audit-write failure rolls back the related status change; Task 6 pins transaction atomicity.
- An operator without `REVIEWER` or `SUPER_ADMIN` cannot review an item from either desktop or mobile UI; Tasks 4, 6, and 8 pin API and UI behavior.

---

## Planned File Structure

```text
.
├─ apps/
│  ├─ api/
│  │  ├─ prisma/schema.prisma
│  │  ├─ src/app.module.ts
│  │  ├─ src/auth/
│  │  ├─ src/audit/
│  │  ├─ src/items/
│  │  └─ test/
│  ├─ admin/
│  │  └─ src/features/review/
│  └─ miniapp/
│     └─ src/pages/items/
├─ packages/
│  └─ contracts/src/
├─ docs/superpowers/
├─ package.json
├─ tsconfig.base.json
├─ .env.example
├─ .gitignore
└─ docker-compose.yml
```

`packages/contracts` owns cross-application enums, request schemas, response types, error codes, and API path constants. Each application owns its rendering, persistence, and framework adapters. Domain state changes live in API services, not controllers or frontend code.

### Task 1: Monorepo and Quality Gates

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `scripts/check-workspaces.mjs`
- Test: `scripts/check-workspaces.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: root commands `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run verify`; workspaces `@barter/contracts`, `@barter/api`, `@barter/admin`, and `@barter/miniapp`.

- [ ] **Step 1: Write the failing workspace-manifest test**

```js
// scripts/check-workspaces.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('root manifest declares every product workspace', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(manifest.workspaces, ['apps/*', 'packages/*']);
  assert.equal(manifest.engines.node, '>=24.15.0');
  assert.ok(manifest.scripts.verify);
});
```

- [ ] **Step 2: Run the test and verify that it fails**

Run: `node --test scripts/check-workspaces.test.mjs`

Expected: FAIL because `package.json` does not exist.

- [ ] **Step 3: Create the root manifest and local infrastructure**

```json
{
  "name": "barter-platform",
  "private": true,
  "engines": { "node": ">=24.15.0" },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "verify": "npm run lint && npm run typecheck && npm test && npm run build"
  }
}
```

Create `docker-compose.yml` with service key `postgres`, container name `barter-postgres`, image `postgres:17`, database `barter`, user `barter`, a non-production local password, healthcheck `pg_isready -U barter`, and host port `5432`. Add matching `DATABASE_URL`, `JWT_SECRET`, `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and `ADMIN_SEED_PASSWORD` keys to `.env.example` without real secrets.

- [ ] **Step 4: Run the manifest test**

Run: `node --test scripts/check-workspaces.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the repository foundation**

```bash
git add package.json tsconfig.base.json .editorconfig .gitignore .env.example docker-compose.yml scripts
git commit -m "build: establish barter monorepo foundation"
```

### Task 2: Shared Contracts Package

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/items.ts`
- Create: `packages/contracts/src/errors.ts`
- Test: `packages/contracts/src/items.test.ts`

**Interfaces:**
- Consumes: root TypeScript configuration from Task 1.
- Produces: `Role`, `ItemStatus`, `ItemCondition`, `CreateItemSchema`, `UpdateItemSchema`, `ReviewItemSchema`, `ItemView`, `ApiErrorCode`, and `ApiErrorBody` from `@barter/contracts`.

- [ ] **Step 1: Write the failing item-contract tests**

```ts
import { describe, expect, it } from 'vitest';
import { CreateItemSchema, ReviewItemSchema } from './items';

describe('CreateItemSchema', () => {
  it('stores money as integer fen and requires three images', () => {
    const result = CreateItemSchema.safeParse({
      title: '九成新连衣裙',
      description: '袖口有轻微使用痕迹，已拍照展示',
      referenceValueFen: 20000,
      condition: 'GOOD',
      imageUrls: ['https://img/1', 'https://img/2', 'https://img/3'],
      wantedText: '希望交换通勤包'
    });
    expect(result.success).toBe(true);
  });

  it('rejects decimal fen and fewer than three images', () => {
    expect(CreateItemSchema.safeParse({
      title: '连衣裙', description: '描述充分', referenceValueFen: 1.5,
      condition: 'GOOD', imageUrls: ['https://img/1'], wantedText: ''
    }).success).toBe(false);
  });
});

describe('ReviewItemSchema', () => {
  it('requires a reason when rejecting', () => {
    expect(ReviewItemSchema.safeParse({ decision: 'REJECT', expectedVersion: 1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the contract tests and verify failure**

Run: `npm test --workspace @barter/contracts`

Expected: FAIL because the package and schemas do not exist.

- [ ] **Step 3: Implement the exact shared contracts**

```ts
// packages/contracts/src/items.ts
import { z } from 'zod';

export const ItemStatusSchema = z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'UNPUBLISHED']);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ItemConditionSchema = z.enum(['LIKE_NEW', 'GOOD', 'FAIR']);
export type ItemCondition = z.infer<typeof ItemConditionSchema>;

export const CreateItemSchema = z.object({
  title: z.string().trim().min(4).max(60),
  description: z.string().trim().min(8).max(2000),
  referenceValueFen: z.number().int().min(100).max(1_000_000),
  condition: ItemConditionSchema,
  imageUrls: z.array(z.string().url()).min(3).max(9),
  wantedText: z.string().trim().max(200)
});

export const UpdateItemSchema = CreateItemSchema.partial();
export const ReviewItemSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('APPROVE'), expectedVersion: z.number().int().positive() }),
  z.object({ decision: z.literal('REJECT'), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(4).max(300) })
]);

export type ItemView = z.infer<typeof CreateItemSchema> & {
  id: string;
  ownerId: string;
  status: ItemStatus;
  version: number;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Define `Role` as `CUSTOMER | OPERATIONS | REVIEWER | SUPER_ADMIN`. Define error codes `AUTH_REQUIRED`, `FORBIDDEN`, `ITEM_NOT_FOUND`, `ITEM_INVALID_STATE`, `ITEM_VERSION_CONFLICT`, and `VALIDATION_FAILED` with response shape `{ code, message, requestId, details? }`.

- [ ] **Step 4: Run tests and type checking**

Run: `npm test --workspace @barter/contracts && npm run typecheck --workspace @barter/contracts`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/contracts package-lock.json
git commit -m "feat: define shared identity and item contracts"
```

### Task 3: API Bootstrap and Database Schema

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/common/zod-validation.pipe.ts`
- Create: `apps/api/src/database/prisma.service.ts`
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/seed.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Test: `apps/api/test/health.e2e-spec.ts`

**Interfaces:**
- Consumes: shared API errors and schemas from Task 2; `DATABASE_URL` from Task 1.
- Produces: running REST API at `/api`, Prisma models `User`, `UserRole`, `AdminCredential`, `Item`, `ItemImage`, `AuditLog`, and `IdempotencyRecord`, plus `GET /api/health` returning `{ status: 'ok' }`.

- [ ] **Step 1: Write the failing health test**

```ts
describe('GET /api/health', () => {
  it('returns an explicit readiness response', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Start PostgreSQL and verify the test fails**

Run: `docker compose up -d postgres && npm test --workspace @barter/api -- health.e2e-spec.ts`

Expected: FAIL because the API workspace does not exist.

- [ ] **Step 3: Scaffold the API and Prisma schema**

Create the Nest application with a global `/api` prefix and a global exception filter that returns `ApiErrorBody`. In Prisma, model users and roles separately, give `Item.version` a default of `1`, store `referenceValueFen` as `Int`, and add indexes on `Item(ownerId, status)` and `Item(status, updatedAt)`. Model audit payloads with nullable JSON `before` and `after` fields.

The seed must create one `SUPER_ADMIN`, one `REVIEWER`, one `OPERATIONS`, and one `CUSTOMER`. Hash the seed admin password; never store plaintext credentials.

- [ ] **Step 4: Apply the migration and run the health test**

Run: `npm run db:migrate --workspace @barter/api -- --name init && npm run db:seed --workspace @barter/api && npm test --workspace @barter/api -- health.e2e-spec.ts`

Expected: migration succeeds and the health test passes.

- [ ] **Step 5: Commit the API foundation**

```bash
git add apps/api package-lock.json
git commit -m "feat: bootstrap api and persistence"
```

### Task 4: Authentication, RBAC, and Audit Infrastructure

**Files:**
- Create: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/auth.service.ts`
- Create: `apps/api/src/auth/wechat-identity.provider.ts`
- Create: `apps/api/src/auth/jwt-auth.guard.ts`
- Create: `apps/api/src/auth/roles.decorator.ts`
- Create: `apps/api/src/auth/roles.guard.ts`
- Create: `apps/api/src/auth/current-user.decorator.ts`
- Create: `apps/api/src/audit/audit.module.ts`
- Create: `apps/api/src/audit/audit.service.ts`
- Test: `apps/api/test/auth-rbac.e2e-spec.ts`
- Test: `apps/api/src/audit/audit.service.spec.ts`

**Interfaces:**
- Consumes: `Role` and `ApiErrorBody`; Prisma models from Task 3.
- Produces: `WechatIdentityProvider.exchangeCode(code): Promise<{ openid: string }>`; `POST /api/auth/wechat`; `POST /api/auth/admin/password`; `GET /api/me`; `@Roles(...roles)`; `AuditService.record(tx, entry)`.

- [ ] **Step 1: Write failing authorization tests**

```ts
it('rejects an operator without reviewer permission', async () => {
  await request(app.getHttpServer())
    .get('/api/admin/session')
    .set('Authorization', `Bearer ${customerToken}`)
    .expect(403)
    .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
});

it('allows an authenticated operator role', async () => {
  await request(app.getHttpServer())
    .get('/api/admin/session')
    .set('Authorization', `Bearer ${reviewerToken}`)
    .expect(200);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm test --workspace @barter/api -- auth-rbac.e2e-spec.ts`

Expected: FAIL because authentication and role guards do not exist.

- [ ] **Step 3: Implement authentication and service-side role checks**

The WeChat endpoint accepts `{ code }`, calls `WechatIdentityProvider.exchangeCode`, upserts a `CUSTOMER`, and returns a short-lived access token plus user view. In tests, override the provider with a deterministic fake. The admin endpoint accepts email and password, verifies the Argon2 hash, and returns roles in the signed token. Add `GET /api/admin/session`, guarded for `OPERATIONS`, `REVIEWER`, or `SUPER_ADMIN`, as the operator app's session bootstrap endpoint.

Implement `RolesGuard` so endpoints deny by default when a required role is absent. Implement `AuditService.record` so callers can pass an existing Prisma transaction client; do not let audit writes occur outside the state-changing transaction.

- [ ] **Step 4: Run authentication and audit tests**

Run: `npm test --workspace @barter/api -- auth-rbac.e2e-spec.ts audit.service.spec.ts`

Expected: PASS, including invalid token, expired token, missing role, and seeded reviewer cases.

- [ ] **Step 5: Commit identity and authorization**

```bash
git add apps/api/src/auth apps/api/src/audit apps/api/test/auth-rbac.e2e-spec.ts
git commit -m "feat: add authentication rbac and audit foundation"
```

### Task 5: Customer Item Draft and Submission API

**Files:**
- Create: `apps/api/src/items/items.module.ts`
- Create: `apps/api/src/items/items.controller.ts`
- Create: `apps/api/src/items/items.service.ts`
- Create: `apps/api/src/items/item.mapper.ts`
- Create: `apps/api/src/storage/storage.module.ts`
- Create: `apps/api/src/storage/image-storage.port.ts`
- Create: `apps/api/src/storage/local-image-storage.adapter.ts`
- Create: `apps/api/src/storage/item-images.controller.ts`
- Test: `apps/api/src/items/items.service.spec.ts`
- Test: `apps/api/test/customer-items.e2e-spec.ts`
- Test: `apps/api/test/item-image-upload.e2e-spec.ts`

**Interfaces:**
- Consumes: `CreateItemSchema`, `UpdateItemSchema`, `ItemView`, authenticated user context, Prisma, and `AuditService.record`.
- Produces: `POST /api/uploads/item-images`, `POST /api/items`, `PATCH /api/items/:id`, `POST /api/items/:id/submit`, `GET /api/me/items`, and `GET /api/me/items/:id`.

- [ ] **Step 1: Write failing ownership and idempotency tests**

```ts
it('does not reveal another user draft', async () => {
  await request(server)
    .get(`/api/me/items/${otherUsersDraftId}`)
    .set('Authorization', `Bearer ${customerToken}`)
    .expect(404)
    .expect(({ body }) => expect(body.code).toBe('ITEM_NOT_FOUND'));
});

it('submits once when the same command id is retried', async () => {
  const commandId = 'submit-item-001';
  await submit(itemId, commandId).expect(200);
  await submit(itemId, commandId).expect(200);
  expect(await countAudit('ITEM_SUBMITTED', itemId)).toBe(1);
});

it('rejects a non-image upload', async () => {
  await request(server)
    .post('/api/uploads/item-images')
    .set('Authorization', `Bearer ${customerToken}`)
    .attach('file', Buffer.from('not an image'), 'note.txt')
    .expect(400)
    .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm test --workspace @barter/api -- customer-items.e2e-spec.ts`

Expected: FAIL because item routes do not exist.

- [ ] **Step 3: Implement draft ownership and state transitions**

Only an owner can read or edit a draft. Return `404` rather than revealing that another user's draft exists. Allow edits in `DRAFT` and `REJECTED`; editing a rejected item clears `rejectReason`, returns it to `DRAFT`, and increments `version`. Submission requires at least three image records and changes `DRAFT` to `PENDING_REVIEW` in the same transaction as `ITEM_SUBMITTED` audit creation.

Define `ImageStoragePort.save({ ownerId, contentType, bytes }): Promise<{ url: string }>` and provide a local adapter that writes only JPEG, PNG, or WebP files up to 8 MB into a configured development directory using generated UUID filenames. Serve that directory only in development and test. The upload endpoint requires a customer token and returns an HTTP URL that satisfies `CreateItemSchema`. Production startup must fail if the local adapter is selected while `NODE_ENV=production`; object-storage deployment is planned with the release phase rather than silently storing production uploads on the API host.

Accept `Idempotency-Key` on submit. Store processed command IDs in an `IdempotencyRecord` table keyed by actor, command name, and key, and return the original response on retry.

- [ ] **Step 4: Run customer item tests**

Run: `npm test --workspace @barter/api -- customer-items.e2e-spec.ts item-image-upload.e2e-spec.ts items.service.spec.ts`

Expected: PASS for create, update, submit, ownership, invalid state, and idempotent retry cases.

- [ ] **Step 5: Commit the customer item API**

```bash
git add apps/api/src/items apps/api/test/customer-items.e2e-spec.ts apps/api/prisma
git commit -m "feat: add customer item drafts and submission"
```

### Task 6: Operator Review API

**Files:**
- Create: `apps/api/src/items/admin-items.controller.ts`
- Create: `apps/api/src/items/item-review.service.ts`
- Test: `apps/api/src/items/item-review.service.spec.ts`
- Test: `apps/api/test/admin-item-review.e2e-spec.ts`

**Interfaces:**
- Consumes: `ReviewItemSchema`, `Role`, Prisma, and `AuditService.record`.
- Produces: `GET /api/admin/items?status=PENDING_REVIEW`, `GET /api/admin/items/:id`, and `POST /api/admin/items/:id/reviews`.

- [ ] **Step 1: Write failing concurrency and atomicity tests**

```ts
it('rejects a stale review', async () => {
  await review(itemId, reviewerOneToken, { decision: 'APPROVE', expectedVersion: 1 }).expect(200);
  await review(itemId, reviewerTwoToken, { decision: 'REJECT', expectedVersion: 1, reason: '图片信息不足' })
    .expect(409)
    .expect(({ body }) => expect(body.code).toBe('ITEM_VERSION_CONFLICT'));
});

it('rolls back approval when audit creation fails', async () => {
  auditService.record.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(service.review(itemId, reviewer, approveInput)).rejects.toThrow('audit unavailable');
  expect((await prisma.item.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('PENDING_REVIEW');
});
```

- [ ] **Step 2: Run the review tests and verify failure**

Run: `npm test --workspace @barter/api -- admin-item-review.e2e-spec.ts item-review.service.spec.ts`

Expected: FAIL because review routes and transitions do not exist.

- [ ] **Step 3: Implement transactional review commands**

Require `REVIEWER` or `SUPER_ADMIN`. Approve only `PENDING_REVIEW` items and change status to `ACTIVE`; reject only `PENDING_REVIEW` items and change status to `REJECTED` with a required reason. Use `updateMany({ where: { id, status: 'PENDING_REVIEW', version: expectedVersion } })` and require exactly one updated row before writing the audit log in the same transaction. Increment `version` on success.

- [ ] **Step 4: Run review and authorization tests**

Run: `npm test --workspace @barter/api -- admin-item-review.e2e-spec.ts item-review.service.spec.ts auth-rbac.e2e-spec.ts`

Expected: PASS for approve, reject, stale version, wrong role, invalid state, and audit rollback.

- [ ] **Step 5: Commit operator review APIs**

```bash
git add apps/api/src/items apps/api/test/admin-item-review.e2e-spec.ts
git commit -m "feat: add audited operator item review"
```

### Task 7: User Miniapp Item Flow

**Files:**
- Create: `apps/miniapp/package.json`
- Create: `apps/miniapp/config/index.ts`
- Create: `apps/miniapp/src/app.config.ts`
- Create: `apps/miniapp/src/app.tsx`
- Create: `apps/miniapp/src/lib/api-client.ts`
- Create: `apps/miniapp/src/features/auth/session.ts`
- Create: `apps/miniapp/src/features/auth/identity-code.provider.ts`
- Create: `apps/miniapp/src/features/images/image-upload.client.ts`
- Create: `apps/miniapp/src/pages/items/create/index.tsx`
- Create: `apps/miniapp/src/pages/items/mine/index.tsx`
- Create: `apps/miniapp/src/pages/items/detail/index.tsx`
- Test: `apps/miniapp/src/pages/items/create/index.test.tsx`
- Test: `apps/miniapp/src/pages/items/mine/index.test.tsx`

**Interfaces:**
- Consumes: customer authentication and item endpoints from Tasks 4 and 5; schemas and `ItemView` from `@barter/contracts`.
- Produces: create-item form, personal item list, item detail, submit-for-review action, and reusable authenticated API client.

- [ ] **Step 1: Write failing form behavior tests**

```tsx
it('blocks submission until three images and required fields are present', async () => {
  render(<CreateItemPage />);
  await userEvent.type(screen.getByLabelText('物品名称'), '九成新连衣裙');
  await userEvent.type(screen.getByLabelText('物品描述'), '袖口轻微使用痕迹，照片已展示');
  expect(screen.getByRole('button', { name: '保存并提交审核' })).toBeDisabled();
});

it('shows rejected reason in my items', async () => {
  api.listMyItems.mockResolvedValue([rejectedItem]);
  render(<MyItemsPage />);
  expect(await screen.findByText('图片未展示瑕疵位置')).toBeVisible();
});
```

- [ ] **Step 2: Run miniapp tests and verify failure**

Run: `npm test --workspace @barter/miniapp`

Expected: FAIL because the Taro workspace and pages do not exist.

- [ ] **Step 3: Implement the minimal user flow**

Use Taro components only in page markup. Validate with `CreateItemSchema` before calling the API. Store access tokens through a session abstraction around `Taro.setStorageSync` and `Taro.getStorageSync`. The personal list groups items by `DRAFT`, `PENDING_REVIEW`, `ACTIVE`, and `REJECTED`; show the rejection reason and an edit action for rejected items.

Implement `ImageUploadClient.upload(localPath): Promise<string>` with `Taro.uploadFile` against `POST /api/uploads/item-images`. Tests inject a fake returning deterministic HTTP URLs. Add `IdentityCodeProvider.getCode()` around `Taro.login`; the H5 acceptance build uses an explicitly configured test provider returning `e2e-customer-code`, while production builds always use `Taro.login` and reject the test provider at startup.

- [ ] **Step 4: Run tests and build the WeChat target**

Run: `npm test --workspace @barter/miniapp && npm run build:weapp --workspace @barter/miniapp && npm run build:h5 --workspace @barter/miniapp`

Expected: component tests pass and `dist/` contains a WeChat miniapp build without TypeScript errors.

- [ ] **Step 5: Commit the user item flow**

```bash
git add apps/miniapp package-lock.json
git commit -m "feat: add miniapp item publishing flow"
```

### Task 8: Responsive Operator Review Workspace

**Files:**
- Create: `apps/admin/package.json`
- Create: `apps/admin/vite.config.ts`
- Create: `apps/admin/src/main.tsx`
- Create: `apps/admin/src/app/router.tsx`
- Create: `apps/admin/src/lib/api-client.ts`
- Create: `apps/admin/src/features/auth/login-page.tsx`
- Create: `apps/admin/src/features/review/review-queue-page.tsx`
- Create: `apps/admin/src/features/review/item-review-page.tsx`
- Create: `apps/admin/src/features/review/review-actions.tsx`
- Create: `apps/admin/src/styles/responsive.css`
- Test: `apps/admin/src/features/review/review-queue-page.test.tsx`
- Test: `apps/admin/src/features/review/review-actions.test.tsx`

**Interfaces:**
- Consumes: admin authentication and review APIs from Tasks 4 and 6; shared `ItemView`, roles, review schema, and errors.
- Produces: desktop review queue, single-item review screen, mobile responsive review flow, and role-aware controls.

- [ ] **Step 1: Write failing role and mobile tests**

```tsx
it('does not render review actions for operations-only users', async () => {
  render(<ReviewActions item={pendingItem} currentRoles={['OPERATIONS']} />);
  expect(screen.queryByRole('button', { name: '审核通过' })).not.toBeInTheDocument();
});

it('keeps single-item review usable at 390px', async () => {
  window.innerWidth = 390;
  window.dispatchEvent(new Event('resize'));
  render(<ItemReviewPage />);
  expect(await screen.findByRole('button', { name: '审核通过' })).toBeVisible();
});
```

- [ ] **Step 2: Run admin tests and verify failure**

Run: `npm test --workspace @barter/admin`

Expected: FAIL because the admin workspace does not exist.

- [ ] **Step 3: Implement the responsive review workspace**

Use Ant Design tables on desktop and stacked cards below 768px. The queue shows image thumbnail, title, owner, reference value, submitted time, and version. The detail page displays every image, description, condition, wanted text, audit history, approve button, and reject form. A `409 ITEM_VERSION_CONFLICT` response refreshes the item and shows “该物品已被其他审核员处理”.

Frontend role hiding improves clarity, but all denied requests must still surface the API's `FORBIDDEN` response without retrying.

- [ ] **Step 4: Run frontend tests and build**

Run: `npm test --workspace @barter/admin && npm run build --workspace @barter/admin`

Expected: tests pass and Vite produces a production build.

- [ ] **Step 5: Commit the operator workspace**

```bash
git add apps/admin package-lock.json
git commit -m "feat: add responsive operator review workspace"
```

### Task 9: End-to-End Acceptance and Project Guidance

**Files:**
- Create: `e2e/playwright.config.ts`
- Create: `e2e/listing-review.spec.ts`
- Create: `e2e/fixtures/item-1.jpg`
- Create: `e2e/fixtures/item-2.jpg`
- Create: `e2e/fixtures/item-3.jpg`
- Create: `README.md`
- Create: `AGENTS.md`
- Create: `.github/workflows/verify.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: all Phase 1 applications and root commands.
- Produces: one-command local setup, repository-specific Codex guidance, CI verification, and a browser acceptance test for the complete item review slice.

- [ ] **Step 1: Write the failing acceptance test**

```ts
test('customer submits an item and reviewer activates it', async ({ browser }) => {
  const customer = await browser.newPage();
  await customer.goto('http://localhost:10086/pages/items/create/index');
  await customer.getByLabel('物品名称').fill('九成新连衣裙');
  await customer.getByLabel('物品描述').fill('袖口轻微使用痕迹，照片已完整展示');
  await customer.getByLabel('参考价值').fill('200');
  await customer.getByLabel('物品图片').setInputFiles([
    'e2e/fixtures/item-1.jpg',
    'e2e/fixtures/item-2.jpg',
    'e2e/fixtures/item-3.jpg'
  ]);
  await customer.getByRole('button', { name: '保存并提交审核' }).click();
  await expect(customer.getByText('等待平台审核')).toBeVisible();

  const reviewer = await browser.newPage();
  await reviewer.goto('http://localhost:5173/login');
  await reviewer.getByLabel('邮箱').fill('reviewer@example.test');
  await reviewer.getByLabel('密码').fill(process.env.E2E_REVIEWER_PASSWORD!);
  await reviewer.getByRole('button', { name: '登录' }).click();
  await reviewer.goto('http://localhost:5173/reviews');
  await reviewer.getByText('九成新连衣裙').click();
  await reviewer.getByRole('button', { name: '审核通过' }).click();
  await expect(reviewer.getByText('已上架')).toBeVisible();
});
```

- [ ] **Step 2: Run the acceptance test and verify failure**

Run: `npm run e2e -- listing-review.spec.ts`

Expected: FAIL before the test environment orchestration and fixtures exist.

- [ ] **Step 3: Add repeatable setup, CI, and Codex guidance**

Add root commands `dev`, `db:reset`, `e2e`, and `verify`. The README must document Node requirements, environment setup, database startup, seed accounts, miniapp build, admin startup, API startup, tests, and the Phase 1 scope boundary.

The project `AGENTS.md` must require reading the approved spec and current implementation plan before changes, using integer fen for money, enforcing permissions in the API, writing an audit log with sensitive state changes, adding tests before behavior changes, running `npm run verify`, and updating design documents when product behavior changes.

Configure CI to install with `npm ci`, start PostgreSQL, run migrations, then run lint, typecheck, unit and integration tests, builds, and the Playwright acceptance test.

- [ ] **Step 4: Run the complete verification suite**

Run: `npm run verify && npm run e2e`

Expected: all workspace tests, type checks, builds, and the listing-review acceptance test pass.

- [ ] **Step 5: Commit the completed Phase 1 slice**

```bash
git add README.md AGENTS.md .github e2e package.json package-lock.json
git commit -m "test: verify item publishing and review slice"
```

## Phase 1 Completion Criteria

- A customer can authenticate, create a valid item draft, edit it, and submit it for review.
- A reviewer can use the web workspace on desktop or mobile width to approve or reject the item.
- Unauthorized roles cannot use review APIs even if they manually call them.
- Ownership checks do not reveal another user's private drafts.
- Concurrent review attempts resolve through an explicit version conflict.
- Submission retries do not duplicate state changes or audit records.
- Audit failures roll back sensitive state changes.
- The WeChat miniapp target and admin production bundle build successfully.
- `npm run verify` and the Playwright acceptance test pass in CI.
- No exchange proposal, order, payment, logistics, or after-sales behavior is accidentally included in Phase 1.
