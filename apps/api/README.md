# Barter API

The API uses PostgreSQL 17 and Prisma ORM 7. Prisma 7 moved connection URLs and seed commands into `prisma.config.ts`, requires an explicit generated-client output, and requires a PostgreSQL driver adapter at runtime. Those are narrow compatibility adjustments to the implementation plan; the database and service boundaries are unchanged.

The local Compose credentials are development-only defaults. Override `DATABASE_URL` and `ADMIN_SEED_PASSWORD` in the environment outside local development. If Compose cannot derive a project name from the checkout directory, run it as `docker compose -p barter up -d postgres`.
