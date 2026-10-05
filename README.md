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

## Layout

```
packages/domain   @supplement-orders/domain: pure money logic and shared types (consumed as TypeScript source)
apps/api          Express + Zod + Drizzle REST API
apps/web          Vue 3 + Vite SPA
```
