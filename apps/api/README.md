# Barter API

The API uses PostgreSQL 17 and Prisma ORM 7. Prisma 7 moved connection URLs and seed commands into `prisma.config.ts`, requires an explicit generated-client output, and requires a PostgreSQL driver adapter at runtime. Those are narrow compatibility adjustments to the implementation plan; the database and service boundaries are unchanged.

The local Compose database credentials are development-only defaults. Set `ADMIN_SEED_PASSWORD` to a nonblank local-only value before running `npm run db:seed --workspace @barter/api`; the seed has no password fallback. Override `DATABASE_URL` outside local development. If Compose cannot derive a project name from the checkout directory, run it as `docker compose -p barter up -d postgres`.
