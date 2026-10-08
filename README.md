# Supplement Orders

A working vertical slice of in-house supplement ordering inside an EHR. A provider assembles a supplement order for a patient and sets the patient-facing price per item. The patient pays through a stubbed gateway. The system splits every paid order into wholesale cost, provider margin and a 75 bps processing fee (ledger type `platform_fee`), and records the split as three immutable ledger entries that sum exactly to the amount paid. Providers also get an Orders tab with a status filter, and a dashboard with sales totals (GMV, margin earned, processing fees) and read-only stock. An admin manages stock levels.

**Live demo: <https://web-production-b7c8c.up.railway.app>.** Auth is stubbed: pick any seeded user on the sign-in screen, no password. All data is fake. The live demo was last deployed before revisions 9 and 10, so it still runs the older payment flow: pay isn't bound to the quote on screen, and the gateway call happens inside one database transaction. This README and the docs describe the code on `main`.

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
  - **Order detail:** lines, split and, once paid, the three ledger entries with a "Total of entries" check (a paid order's split is read from its ledger). Actions depend on status: **Delete draft**, **Cancel order** (awaiting payment), **Reopen as draft** (cancelled). Paid orders have no actions. Cancelling an order also cancels its back-orders.
  - **Orders:** all of the provider's orders, filtered by a multi-select Status (Draft, Awaiting payment, Awaiting stock, Paid, Cancelled; all statuses by default).
  - **Dashboard:** a date range (This month by default, Last 30 days, All time or custom), GMV, margin earned and processing fee tiles, "See paid orders →" and "See orders awaiting payment →" links into the Orders tab, and a searchable, read-only inventory.
  - List filters, searches and pages are kept in the URL, so reload, Back and shared links restore the same view.
- **Patient** (nav: My Orders): sees sent orders and pays them, in full or, when stock is short, for the in-stock items. Never sees wholesale cost, margin or the fee.
- **Admin** (nav: Inventory): adds to or sets product stock. Sees no provider or patient data.
- Page content is centered in a max-width column on wide screens.

## Quickstart

Prerequisites: Node 22 LTS, 22.13 or later (`engines` in `package.json` is `>=22.13 <23`, which also pins Railway to Node 22), npm, and Docker. Parts of the app were developed on Node 23 with npm 10.9; npm warns about the engines range there, but the tests pass.

`npm ci` and `npm install` from the committed lockfile work on npm 10. Changing the Vitest version is different: npm 10.9 crashes while resolving Vitest 4, so regenerate the lockfile with npm 11 (for example `npx npm@11 install`).

```sh
npm install
npm run db:up        # Postgres 16 in Docker on localhost:54329; waits until healthy
npm run db:migrate   # applies migrations 0000-0013 (includes the pg_trgm extension)
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
| Ada Admin            | Admin    | Manage stock under Inventory (no provider or patient data)            |

`npm run db:seed` also adds generated data: 300 products in one catalog, and 250 patients split between the two providers, so search and pagination have something to page through. A few generated patients share a name and a provider and differ by date of birth and address.

A demo path: sign in as Dr. Maya Rivera, open Jordan Lee, click **New order**, add a product through **Add line**, set Markup % or Patient price, **Send to patient**. Sign out, sign in as Jordan Lee, open the order under My orders and click **Pay**. Sign back in as Dr. Rivera to see the order's ledger, find it under Orders, and check the dashboard. On the live demo, other visitors may have created orders too.

The patient pay screen has no failure control. Outside production the API accepts `simulateFailure: true` on the pay request (the e2e test adds it to the request). A simulated decline records no payment and no ledger rows, and gives back the stock the attempt had reserved. The order stays payable; paying again starts a new attempt with a new idempotency key.

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

Pay is bound to the quote the patient saw: the request carries the order's `revision` and total, and a stale screen gets 409 `ORDER_CHANGED` and isn't charged. Each charge goes through a durable payment attempt that reserves stock first and has its own idempotency key, so a retry or a restart can't charge twice. The full sequence is in [Architecture §6](docs/ARCHITECTURE.md#6-core-flow).

### Stock

An admin (Ada Admin) manages stock (revision 13, at the product owner's request; this reverses the earlier reading that stock is never edited by hand). Providers and patients can't change it, and the provider dashboard's inventory stays read-only. The admin can add to a product's stock (an atomic increment, so concurrent additions never conflict) or set it to an exact value. Setting is a compare-and-set against the value the admin loaded: if a payment reserved stock or another admin changed it in the meantime, the API answers 409 `STOCK_CHANGED` with the current value and changes nothing. An admin sets stock to a value between 0 and 1,000,000. A declined payment gives its reservation back without clamping, so stock can briefly sit above the bound; the set's expected value may be any non-negative integer, so it can always be corrected (revision 15.4). Every admin change is recorded in an append-only `inventory_adjustments` table. The admin edits available stock, the same number the dashboard shows. A pay attempt reserves the order's quantities before charging, a decline gives them back, and a recorded payment keeps them as the sale. So an order whose payment is in progress, or waiting for reconciliation, already counts against the stock shown.

### Low stock and back-orders

Revision 14 lets a provider send quantities above the stock available now: the builder warns, saving is never blocked, and send asks for an explicit acknowledgement (`acknowledgeLowStock`). Stock is still reserved only when the patient pays.

- **Awaiting stock.** An order awaiting payment none of whose lines is in stock shows as **Awaiting stock**. This status is derived, not stored: the `orders_with_status` view computes it from current stock on every read, so restocking or a sale is reflected immediately.
- **Paying for what's in stock.** The patient sees what is payable now. Paying in full with any shortfall is refused (409 `INSUFFICIENT_STOCK`). Choosing to pay for the in-stock items (`mode: 'available'`) charges exactly the in-stock total the patient saw, and in the same locked transaction moves the shortfall to one new **back-order** at the original unit prices. The paid order and its back-order link to each other. If stock moved in the meantime, the patient gets 409 `ORDER_CHANGED` with the refreshed amounts and nothing is charged.
- **Chains.** A back-order is paid like any order, and partially paying it creates the next back-order. Retrying the same request, even after a restart, never splits or charges twice.
- **Lifecycle.** A back-order can be cancelled but never edited or reopened (409 `BACKORDER_NOT_EDITABLE`). Each order is charged its own processing fee, so a split can cost the provider at most one cent more in fees than the unsplit order.
- **Quote binding** (revision 15.2). Paying for the in-stock items sends `expectedPayableLines`, the exact in-stock products and quantities on screen. If the server's plan names different lines, even at the same total, the answer is 409 `ORDER_CHANGED` with the refreshed quote (`error.partialPaymentQuote`) and nothing is charged. A full pay with a shortfall gets the same quote with 409 `INSUFFICIENT_STOCK`.
- **Chains** (revision 15.3). A back-order can't be paid until the order it came from is paid (409 `PRIOR_ORDER_UNPAID`); the patient sees "Pay order #A first" with a link. Cancelling an order cancels its whole downstream chain, all or nothing: if any order in it has a payment in progress, nothing is cancelled. Reopening a cancelled original leaves its back-orders cancelled, and deleting the reopened draft deletes them too.
- **Recovery** (revision 15.1). An order whose payment is in progress keeps its reserved stock as its own, so it never shows as awaiting stock. The patient sees "Your payment is being processed" and a **Complete payment** button, which retries the same attempt and can't charge twice.
- **Frozen paid records** (revision 15.5). Each line stores the product name and SKU it was sold under, and database triggers reject any change to a paid order or its lines, so renaming a product or a stray `UPDATE` can't rewrite a sale.

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
- `NODE_ENV=production`: turns on static serving and turns off `simulateFailure` on the pay request. The decline path is demonstrated locally.
- `PORT`: provided by Railway.

Production static serving: hashed files under `/assets/` are cached for a year, a missing `/assets/` file is a plain 404, `index.html` is `no-cache`, and any other non-`/api` GET returns `index.html` so deep links such as `/orders?status=paid` work. Unknown `/api` routes still return a JSON 404.

To deploy, run `railway up` from the repo root on an up-to-date `main`. Railway's repo auto-deploy only supports GitHub, and this repository is on GitLab.

**Auth is stubbed on the public demo too.** Anyone with the URL can sign in as any seeded user and create, pay or cancel orders. All the data is fake.

## What's stubbed

| Concern          | Stub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments         | `FakePaymentGateway` stands in for a processor with durable idempotency. It keeps every charge in its own table, `fake_gateway_charges`, written in its own committed statements. The first call for a key decides the outcome; later calls with the same key and amount replay it, a different amount is refused, and `lookup` never charges. It always succeeds unless failure is forced: `{ simulateFailure: true }` on the pay request forces a decline unless `NODE_ENV` is `production` |
| Auth             | The login screen stores the chosen user id in localStorage; the client sends it as `X-User-Id`. `HeaderAuth` looks the user up and takes the role from the database. Unknown or missing id is a 401. No passwords or sessions                                                                                                                                                                                                                                                                 |
| Notifications    | `ConsoleNotifier` logs `[notifier] order <id> is ready for patient payment` and `[notifier] order <id> was cancelled by the provider` to the API console                                                                                                                                                                                                                                                                                                                                      |
| Shipping and tax | Not modeled. The patient's address is shown as a plain string                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Each stub sits behind an interface in `apps/api/src/seams/` and is injected through `createApp`, so a real implementation replaces the fake without touching domain code.

## Testing

| Suite                                         | Count              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain` (Vitest)                    | 381 in 12 files    | Fee, minimum price, split, partial-payment planning and fee bound, ledger, markup conversions, money parsing and formatting, request schemas and draft bounds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api` (Vitest + Supertest)               | 407 in 38 files    | Against a real Postgres: revision 15 fixes (held-stock recovery after a failed finalization and restart, payable-line approval, chain cancel and delete, pay order in a chain, stock correction above the bound, frozen paid orders and their lines), revision 14 back-orders (derived awaiting stock, full and partial pay, stale quotes, replay across a restart, concurrent splits, chains, back-order lifecycle, send acknowledgement), HTTP contract tests, stale-quote and payment-integrity tests (fenced outcomes, overlapping and held gateway responses, key conflicts, restart recovery with a fresh gateway and app on the same database), concurrent pay/cancel, delete and reopen, admin stock (concurrent increments, compare-and-set racing a payment reservation, audit rows), order list filters, search, dashboard snapshot, SPA serving |
| `apps/web` (Vitest + Testing Library + jsdom) | 303 in 29 files    | Views and components, 16 axe-core accessibility scans, 23 loading/error/empty/persona state tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `e2e/` (Playwright)                           | 10 files, 25 tests | Admin stock, back-orders (partial pay, chains, restock, stale quote, filters), dashboard range, happy path (order, pay, ledger, exact dashboard and stock deltas), simulated gateway failure, cancel, order lifecycle (delete draft, cancel, reopen, status filters), a stale patient page that must reload before paying the new total, URL-state navigation (4 cases)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
  drizzle/            SQL migrations 0000-0013
  scripts/            explain-search.ts
apps/web              Vue 3 + Vite + PrimeVue SPA (views, components, api client, a11y and state tests)
e2e/                  Playwright specs
docs/                 Architecture, decisions, AI usage, screenshots
```
