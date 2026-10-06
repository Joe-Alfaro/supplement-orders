# Supplement Orders

Vertical slice of in-house supplement ordering: a provider assembles an order for a patient, the patient pays, and the system computes and records the money split (COGS, provider margin, 75 bps platform fee).

Stack: Vue 3 + TypeScript, Express REST API, Postgres. See `docs/` for architecture and the AI usage write-up (added at submission).

## Local setup

Requires Node 22+, npm, and Docker.

```sh
npm install
npm run db:up    # Postgres 16 on localhost:54329, waits until healthy
npm run dev      # API on :3000, web on :5173 (proxies /api to the API)
```

Open http://localhost:5173. `GET /api/health` returns 200 when the API can reach Postgres.

The API defaults `DATABASE_URL` to the local Docker database; copy `apps/api/.env.example` to `apps/api/.env` to override it.

Other scripts: `npm test`, `npm run lint`, `npm run format`, `npm run typecheck`, `npm run build`, `npm run db:migrate`, `npm run db:seed`, `npm run db:down`.

## Tests

`npm test` runs every workspace's unit tests. The API tests need the Docker Postgres (`npm run db:up`); they create, migrate, and truncate their own database on that server and never touch the dev database `supplement_orders`.

Each checkout gets its own API test database, so suites running at the same time in different worktrees can't truncate each other's data. The name is the first of:

1. `TEST_DATABASE_NAME`, if set (a plain lowercase Postgres identifier, at most 63 characters).
2. `supplement_orders_test_<AO_SESSION_ID>`, if `AO_SESSION_ID` is set (non-identifier characters become `_`; long ids are shortened and suffixed with a hash).
3. `supplement_orders_test_<hash>`, where `<hash>` is the first 8 hex characters of the SHA-256 of the repo root path.

The database sits beside `DATABASE_URL` on the same server and is created on first run. `TEST_DATABASE_URL` overrides all of this with a full connection string. Leftover test databases can be dropped with `docker compose exec postgres psql -U supplement_orders -d postgres -c 'drop database <name>'`.

The browser end-to-end suite (`npm run test:e2e`) uses the separate `supplement_orders_e2e` database.

## Layout

```
packages/domain   @supplement-orders/domain: pure money logic and shared types (consumed as TypeScript source)
apps/api          Express + Zod + Drizzle REST API
apps/web          Vue 3 + Vite SPA
```
