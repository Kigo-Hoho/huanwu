# Repository guidance

Before changing product behavior or architecture, read both approved sources of truth:

- `docs/superpowers/specs/2026-09-22-barter-miniapp-dual-workbench-design.md`
- `docs/superpowers/plans/2026-09-22-foundation-listing-review-implementation.md`
- For Phase 2 work, also read `docs/superpowers/specs/2026-09-29-barter-proposals-design.md` and `docs/superpowers/plans/2026-09-29-barter-proposals-implementation.md`.

Apply these rules to every change in this repository:

- Store and exchange monetary values as integer fen. Never use floating-point yuan in persistence or API contracts.
- Enforce authentication, ownership, roles, and permissions in the API. Frontend visibility is not an authorization boundary.
- Write an immutable audit log in the same transaction as every sensitive state change, including reviews, rejections, unpublishing, freezes, and permission-sensitive operations.
- Add or update tests before changing behavior. Observe the relevant test fail for the intended reason, implement the smallest change, then run it green.
- Run `npm run verify` before declaring work complete. Run the relevant browser acceptance test when a user-facing cross-application flow changes.
- Update the approved design and implementation documents whenever product behavior, scope, architecture, or a public contract changes.
- Preserve Phase 1 publishing/review behavior. Phase 2 adds discovery, structured proposals, alternating negotiation and 72-hour reservations only; never add orders, payments, logistics, chat or after-sales in Phase 2.
- Proposal commands require a CUSTOMER session, an idempotency key and (except creation) expectedVersion. Operators only use separate read endpoints; never impersonate a participant. Clients must preserve a logical command key across uncertain network retries and refresh on stale version conflicts.
- Keep production identity and storage adapters real. Test-only adapters must be explicitly selected, restricted to non-production environments, and must never become production fallbacks.
