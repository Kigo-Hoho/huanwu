# Repository guidance

Before changing product behavior or architecture, read both approved sources of truth:

- `docs/superpowers/specs/2026-09-22-barter-miniapp-dual-workbench-design.md`
- `docs/superpowers/plans/2026-09-22-foundation-listing-review-implementation.md`
- For Phase 2 work, also read `docs/superpowers/specs/2026-09-29-barter-proposals-design.md` and `docs/superpowers/plans/2026-09-29-barter-proposals-implementation.md`.
- For Phase 3 work, also read `docs/superpowers/specs/2026-10-02-barter-orders-fulfillment-design.md` and `docs/superpowers/plans/2026-10-02-barter-orders-fulfillment-implementation.md`.

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
- Phase 3 user commands require a pure CUSTOMER session; mixed operator/customer roles are rejected. Operators use independent read-only, redacted order queries.
- External funds cannot be undone by database rollback. Persist outbox and immutable financial/audit facts transactionally, reconcile unknown results using the original business number, and never replace it to repeat a charge/refund/settlement. Address plaintext, checkout credentials and keys never enter generic responses, idempotency caches or audits.
- Any shipment registration or in-person handover blocks safe cancellation. Refund/settlement uncertainty retains reservations. ON_HOLD never automatically accepts, refunds, releases, or resumes; interventions belong to Phase 4.
- Keep Prisma 7 and the existing Vitest runners. Consult official version-7 migration documentation; do not edit applied migrations, accept resets, or substitute SQLite for PostgreSQL.
- Browser acceptance runs through root `npm run e2e`, which creates/migrates/seeds only its owned namespace database and awaits server teardown, non-FORCE DROP and catalog/source proofs. Never run preparation migrations against a retained business database. CI uses an ephemeral PostgreSQL role able to create and drop its own test databases; runtime API keys remain outside frontend environments.
- Before claiming Phase 3 completion run lint, typecheck, test, build, verify and e2e as six separate commands. Record warnings and external CI limitations honestly; independent task and whole-branch reviews must actually occur before marking them complete.
