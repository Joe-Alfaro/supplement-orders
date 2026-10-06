# Supplement Orders

A working vertical slice of in-house supplement ordering inside an EHR. A provider assembles a supplement order for a patient and sets the patient-facing price per item. The patient pays through a stubbed gateway. The system splits every paid order into wholesale cost, provider margin and a 75 bps processing fee (ledger type `platform_fee`), and records the split as three immutable ledger entries that sum exactly to the amount paid. Providers also get an Orders tab with a status filter, and a dashboard with sales totals (GMV, margin earned, processing fees) and read-only stock.

**Live demo: <https://web-production-b7c8c.up.railway.app>.** Auth is stubbed: pick any seeded user on the sign-in screen, no password. All data is fake.

Stack: TypeScript end to end. Vue 3 + Vite + PrimeVue 4 on the front end, an Express 5 REST API with Zod validation, Drizzle ORM, and Postgres 16. npm workspaces share one domain package, so the money logic lives in exactly one place.

- [Architecture](docs/ARCHITECTURE.md)
- [Decisions and tradeoffs](docs/DECISIONS.md)
- [How AI was used](docs/AI_USAGE.md)

## Screenshots

Captured from the live demo at 1440x900, signed in as Dr. Maya Rivera.

![Sign-in screen with a notice that authentication is stubbed and a single user dropdown](docs/screenshots/login.png)

![Patients list with a name or date-of-birth search box, a Latest order status filter, and a table of patients with date of birth, order count and latest order](docs/screenshots/patients.png)

![Add-product dialog, step 2, for Magnesium Glycinate: wholesale cost $12.75, minimum price $12.85, Markup % 60.00, read-only processing fee $0.16, patient price $20.55](docs/screenshots/order-builder-add-product.png)

![Orders tab with the Status multi-select open and every status checked: Draft, Awaiting payment, Paid, Cancelled](docs/screenshots/orders-status-filter.png)

![Dashboard with GMV, margin earned and processing fee tiles, links to paid and awaiting-payment orders, and a searchable read-only inventory table](docs/screenshots/dashboard.png)

## Features

- **Provider** (nav: Patients | Orders | Dashboard)
  - **Patients:** search by name or date of birth (`MM/DD/YYYY` or `YYYY-MM-DD`), filter by latest order status, paginated.
  - **Order builder:** add products through a searchable Add-product dialog, then set Markup % or Patient price (linked both ways). The line's processing fee is shown read-only and rounds up to the cent. The price starts at the product's minimum. Drafts can be saved incomplete; Send requires every line complete and at or above its minimum.
  - **Order detail:** lines, split and, once paid, the three ledger entries with a "Total of entries" check. Actions depend on status: **Delete draft**, **Cancel order** (awaiting payment), **Reopen as draft** (cancelled). Paid orders have no actions.
  - **Orders:** all of the provider's orders, filtered by a multi-select Status (Draft, Awaiting payment, Paid, Cancelled; all statuses by default).
  - **Dashboard:** GMV, margin earned and processing fee tiles, "See paid orders →" and "See orders awaiting payment →" links into the Orders tab, and a searchable, read-only inventory.
  - List filters, searches and pages are kept in the URL, so reload, Back and shared links restore the same view.
- **Patient** (nav: My Orders): sees sent orders and pays them. Never sees wholesale cost, margin or the fee.
- Page content is centered in a max-width column on wide screens.

## Quickstart

Prerequisites: Node 22 LTS, 22.13 or later (`engines` in `package.json` is `>=22.13 <23`, which also pins Railway to Node 22), npm, and Docker. Parts of the app were developed on Node 23 with npm 10.9; npm warns about the engines range there, but the tests pass.

```sh
npm install
npm run db:up        # Postgres 16 in Docker on localhost:54329; waits until healthy
npm run db:migrate   # applies migrations 0000-0006 (includes the pg_trgm extension)
npm run db:seed      # wipes the dev database and loads the demo seed
npm run dev          # API on http://localhost:3000, web on http://localhost:5173
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the API. `GET /api/health` returns 200 when the API can reach Postgres.

The API defaults `DATABASE_URL` to the Docker database (`postgres://supplement_orders:supplement_orders@localhost:54329/supplement_orders`). To override it or `PORT`, copy `apps/api/.env.example` to `apps/api/.env`.

### Signing in

Authentication is stubbed. The `/login` dropdown lists every user in the database, including the generated patients described below. Pick one and click **Sign in**; there is no password. The role comes from the user record on the server, never from the client. The named users are:

| User                 | Role     | Use it to                                                             |
| -------------------- | -------- | --------------------------------------------------------------------- |
| Dr. Maya Rivera      | Provider | Build and send orders for Jordan Lee or Sam Patel, view the dashboard |
| Jordan Lee           | Patient  | Pay an order Dr. Rivera sent                                          |
| Dr. Owen Brooks      | Provider | A second provider, to see that providers can't see each other's data  |
| Sam Patel            | Patient  | Dr. Rivera's second patient                                           |
| Alex Kim, Riley Chen | Patient  | Dr. Brooks's patients                                                 |

`npm run db:seed` also adds generated data: 300 products in one catalog, and 250 patients split between the two providers, so search and pagination have something to page through. A few generated patients share a name and a provider and differ by date of birth and address.

A demo path: sign in as Dr. Maya Rivera, open Jordan Lee, click **New order**, add a product through **Add line**, set Markup % or Patient price, **Send to patient**. Sign out, sign in as Jordan Lee, open the order under My orders and click **Pay**. Sign back in as Dr. Rivera to see the order's ledger, find it under Orders, and check the dashboard. On the live demo, other visitors may have created orders too.

In development builds the patient pay screen has a "Simulate gateway failure (dev only)" checkbox. A simulated decline rolls back everything: no payment, no ledger rows, no stock change.

## Scripts

Run from the repo root.

| Script                               | What it does                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                        | API (`tsx watch`, port 3000) and web (Vite, port 5173) together                                                                                              |
| `npm run build`                      | Builds the web app to `apps/web/dist`. The API runs from TypeScript source under `tsx` and has no build step                                                 |
| `npm start`                          | Runs the API under `tsx`. With `NODE_ENV=production` it also serves `apps/web/dist` (see [Deployment](#deployment))                                          |
| `npm test`                           | Unit and integration tests for every workspace (the API tests need `npm run db:up`)                                                                          |
| `npm run lint`                       | ESLint plus `prettier --check` (Prettier also covers Markdown)                                                                                               |
| `npm run format`                     | `prettier --write`                                                                                                                                           |
| `npm run typecheck`                  | `tsc` for the domain and API packages, `vue-tsc` for the web app                                                                                             |
| `npm run test:e2e`                   | Playwright end-to-end suite (Chromium, headless). Starts its own API and web servers                                                                         |
| `npm run e2e:db`                     | Creates, migrates and resets the `supplement_orders_e2e` database to the small named seed                                                                                |
| `npm run e2e:api`                    | API on port 3100 against `supplement_orders_e2e`                                                                                                                         |
| `npm run e2e:web`                    | Vite on port 5174, proxying `/api` to port 3100                                                                                                              |
| `npm run db:up` / `db:down`          | Start or stop the Docker Postgres                                                                                                                            |
| `npm run db:migrate`                 | Apply Drizzle migrations to the dev database                                                                                                                 |
| `npm run db:seed`                    | Truncate the dev database and load the named seed plus the generated demo rows                                                                               |
| `npm run db:seed:if-empty`           | Load the same full seed only if there are no users yet. Never deletes anything; the deploy runs it every time                                                |
| `npm run explain:search -w apps/api` | Loads 50,000 products and 20,000 patients into a throwaway database and prints `EXPLAIN ANALYZE` for the search queries before and after the trigram indexes |

The first `npm run test:e2e` on a machine may need `npx playwright install chromium`.

## How the money works

All money is integer cents (USD). No floats in the money path. The split is a pure function in `packages/domain/src/money/split.ts`, shared by the API and the browser.

- **The patient pays exactly the price the provider set.** There is no fee line and no surcharge on the patient's side.
- **Processing fee:** 0.75% (75 bps) of the order subtotal, **rounded up** to the next cent, computed once per order, never per line.
- **Provider margin** = subtotal - wholesale cost - processing fee.
- **Minimum price:** each unit price must be at least the smallest price whose markup covers 75 bps of that price rounded up. That is `cost + ceil(75 * cost / 9925)`. With every line at or above its minimum, the provider margin can't be negative. The minimum is enforced when the order is sent; drafts can be saved incomplete or below it.
- **Markup %** in the order builder is the provider's net markup on wholesale cost after the fee: `(price - cost - 0.0075 * price) / cost`. It's uncapped and linked both ways with the patient price. 0% means the minimum price.

Worked example: a product with a $5.81 wholesale cost has a minimum price of $5.86. At $5.86 the fee is 75 bps of $5.86 = 4.395 cents, rounded up to $0.05, so cost + fee = minimum and the provider margin is $0.00. At $120.00 against $70.00 wholesale, the fee is exactly $0.90 and the provider keeps $49.10.

When the patient pays, the API writes three ledger entries (`cogs`, `provider_margin`, `platform_fee`) whose sum is asserted to equal the payment amount before they're inserted. The provider's order detail shows them with a "Total of entries" row. The dashboard's GMV comes from payments, and its margin and fee totals come from the ledger.

## Deployment

Public demo: <https://web-production-b7c8c.up.railway.app>

The app runs on [Railway](https://railway.com) as one service plus a Railway Postgres service. The API serves the built web app, so there is one origin and no CORS. [`railway.json`](railway.json) records the build and deploy settings. Railway has [deprecated Config as Code](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code) and new services do not read it, so the same values are applied to the service directly:

| Step       | Command                                          | Notes                                                                                                                      |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Build      | `npm run build`                                  | Railpack, Node 22 from `engines`. Railpack's install step includes dev dependencies (Vite) even with `NODE_ENV=production` |
| Pre-deploy | `npm run db:migrate && npm run db:seed:if-empty` | Runs before each release. Migrations are idempotent; the seed only runs on an empty database                               |
| Start      | `npm start`                                      | API under `tsx`, serving `apps/web/dist` with history fallback                                                             |
| Health     | `GET /api/health`                                | Returns 503 when the database is unreachable. Restart policy: on failure                                                   |

Service variables:

- `DATABASE_URL`: a reference to the Postgres service's private URL, `${{Postgres.DATABASE_URL}}`.
- `NODE_ENV=production`: turns on static serving and turns off **Simulate gateway failure**. The decline and rollback path is demonstrated locally.
- `PORT`: provided by Railway.

Production static serving: hashed files under `/assets/` are cached for a year, `index.html` is `no-cache`, and any other non-`/api` GET returns `index.html` so deep links such as `/orders?status=paid` work. Unknown `/api` routes still return a JSON 404.

To deploy, run `railway up` from the repo root on an up-to-date `main`. Railway's repo auto-deploy only supports GitHub, and this repository is on GitLab.

**Auth is stubbed on the public demo too.** Anyone with the URL can sign in as any seeded user and create, pay or cancel orders. All the data is fake.

## What's stubbed

| Concern          | Stub                                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments         | `FakePaymentGateway` (in-process) always succeeds unless failure is forced, and replays the original result for a repeated idempotency key. `{ simulateFailure: true }` on the pay request forces a decline unless `NODE_ENV` is `production` |
| Auth             | The login screen stores the chosen user id in localStorage; the client sends it as `X-User-Id`. `HeaderAuth` looks the user up and takes the role from the database. Unknown or missing id is a 401. No passwords or sessions                 |
| Notifications    | `ConsoleNotifier` logs `[notifier] order <id> is ready for patient payment` and `[notifier] order <id> was cancelled by the provider` to the API console                                                                                      |
| Shipping and tax | Not modeled. The patient's address is shown as a plain string                                                                                                                                                                                 |

Each stub sits behind an interface in `apps/api/src/seams/` and is injected through `createApp`, so a real implementation replaces the fake without touching domain code.

## Testing

| Suite                                         | Count | Notes                                                                                                                                                                |
| --------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain` (Vitest)                    | 308   | Fee, minimum price, split, ledger, markup conversions, money parsing and formatting, request schemas                                                                 |
| `apps/api` (Vitest + Supertest)               | 195   | Against a real Postgres: HTTP contract tests, pay rollback and idempotency, concurrent pay/cancel, delete and reopen, order list filters, search, SPA serving        |
| `apps/web` (Vitest + Testing Library + jsdom) | 141   | Views and components, 16 axe-core accessibility scans, 23 loading/error/empty/persona state tests                                                                    |
| `e2e/` (Playwright)                           | 4     | Happy path (order, pay, ledger, exact dashboard and stock deltas), simulated gateway failure, cancel, order lifecycle (delete draft, cancel, reopen, status filters) |

Counts are from `npm test` and `npm run test:e2e` at the time of writing.

- The API tests use their own database on the same Postgres server, created on first run and truncated per test. Each checkout gets its own test database (from `TEST_DATABASE_NAME`, else `AO_SESSION_ID`, else a hash of the repo path), so parallel checkouts don't interfere. `TEST_DATABASE_URL` overrides it.
- The axe scans run in jsdom with WCAG 2.0/2.1 A and AA plus best-practice rules. `color-contrast` is disabled there because jsdom can't compute styles.
- Web tests follow Testing Library conventions (`screen` queries, `user-event`, jest-dom matchers), enforced by `eslint-plugin-testing-library`. End-to-end tests use only Playwright's role, label and text locators.
- Tests were written test-first, mostly by a different model from the one that wrote the implementation. See [AI usage](docs/AI_USAGE.md).

## Repository layout

```
packages/domain       @supplement-orders/domain: money logic (split, fee, minimum price, markup, ledger,
                      format/parse) and the shared API types and Zod schemas. Consumed as
                      TypeScript source, no build step
apps/api              Express REST API
  src/http/           routes, error mapping, production SPA serving, HTTP contract tests
  src/orders/         order service (send, pay, cancel, delete, reopen) and read views
  src/seams/          Auth, PaymentGateway, Notifier interfaces and fakes
  src/db/             Drizzle schema, migration runner, seed, test/e2e database helpers
  drizzle/            SQL migrations 0000-0006
  scripts/            explain-search.ts
apps/web              Vue 3 + Vite + PrimeVue SPA (views, components, api client, a11y and state tests)
e2e/                  Playwright specs
docs/                 Architecture, decisions, AI usage, screenshots
```
