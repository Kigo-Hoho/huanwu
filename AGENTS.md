# Repository guidance

Before changing product behavior or architecture, read both approved sources of truth:

- `docs/superpowers/specs/2026-09-22-barter-miniapp-dual-workbench-design.md`
- `docs/superpowers/plans/2026-09-22-foundation-listing-review-implementation.md`

Apply these rules to every change in this repository:

- Store and exchange monetary values as integer fen. Never use floating-point yuan in persistence or API contracts.
- Enforce authentication, ownership, roles, and permissions in the API. Frontend visibility is not an authorization boundary.
- Write an immutable audit log in the same transaction as every sensitive state change, including reviews, rejections, unpublishing, freezes, and permission-sensitive operations.
- Add or update tests before changing behavior. Observe the relevant test fail for the intended reason, implement the smallest change, then run it green.
- Run `npm run verify` before declaring work complete. Run the relevant browser acceptance test when a user-facing cross-application flow changes.
- Update the approved design and implementation documents whenever product behavior, scope, architecture, or a public contract changes.
- Keep Phase 1 limited to customer item publishing and operator review. Do not add exchange proposals, orders, payments, logistics, or after-sales behavior in this phase.
- Keep production identity and storage adapters real. Test-only adapters must be explicitly selected, restricted to non-production environments, and must never become production fallbacks.
