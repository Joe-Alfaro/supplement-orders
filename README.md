# Supplement Orders

A working vertical slice of in-house supplement ordering inside an EHR. A provider assembles a supplement order for a patient and sets the patient-facing price per item. The patient pays through a stubbed gateway. The system splits every paid order into wholesale cost, provider margin and a 75 bps processing fee, and records it in a double-entry ledger: one immutable journal per payment that debits Cash with the amount paid and credits product sales, the provider's payable account and platform fee revenue, so debits always equal credits. Providers also get an Orders tab with a status filter, and a dashboard with sales totals (GMV, margin earned, processing fees), what sold by product, and read-only stock. An admin manages stock levels and reconciles stranded payments.

**Live demo: <https://web-production-b7c8c.up.railway.app>.** Auth is stubbed: pick one of the demo personas on the sign-in screen, no password. All data, personas included, is fictitious. GitLab CI tests every push and deploys `main` once the tests pass, so the demo runs the code this README describes.

Stack: TypeScript end to end. Vue 3 + Vite + PrimeVue 4 on the front end, an Express 5 REST API with Zod validation, Drizzle ORM, and Postgres 16. npm workspaces share one domain package, so the money logic lives in exactly one place.

- [Architecture](docs/ARCHITECTURE.md)
- [Decisions and tradeoffs](docs/DECISIONS.md)
- [How AI was used](docs/AI_USAGE.md)

## Screenshots

Captured at 1440x900 from a freshly seeded instance, signed in as Dr. Maya Rivera.

![Sign-in screen with a notice that authentication is stubbed and a single user dropdown](docs/screenshots/login.png)

![Patients list with a name or date-of-birth search box, a Latest order status filter, and a table of patients with date of birth, order count and latest order](docs/screenshots/patients.png)

![Add-product dialog, step 2, for Magnesium Glycinate: wholesale cost $12.75, minimum price $12.85, Markup % 60.00, read-only processing fee $0.16, patient price $20.55, margin $7.64](docs/screenshots/order-builder-add-product.png)

![Orders tab with the Status multi-select open and every status checked: Draft, Awaiting payment, Awaiting stock, Paid, Cancelled](docs/screenshots/orders-status-filter.png)

![Dashboard with a date range picker, GMV, margin earned, processing fee and owed-to-you tiles, links to paid and awaiting-payment orders, and a searchable read-only inventory table](docs/screenshots/dashboard.png)

## Features

- **Provider** (nav: Patients | Orders | Dashboard)
  - **Patients:** search by name or date of birth (`MM/DD/YYYY` or `YYYY-MM-DD`), filter by latest order status, paginated.
  - **Order builder:** add products through a searchable Add-product dialog, then set Markup % or Patient price (linked both ways). The line's processing fee is shown read-only and rounds up to the cent. The price starts at the product's minimum. Drafts can be saved incomplete; Send requires every line complete and at or above its minimum. An order has at most 100 lines (400 `VALIDATION_ERROR` on `lines`, revision 18.4).
  - **Order detail:** lines, split and, once paid, the payment's journal (a paid order's split is read from its journal postings). Actions depend on status: **Delete draft**, **Cancel order** (awaiting payment), **Reopen as draft** (cancelled). Paid orders have no actions. Cancelling an order also cancels its back-orders.
  - **Orders:** all of the provider's orders, filtered by a multi-select Status (Draft, Awaiting payment, Awaiting stock, Paid, Cancelled; all statuses by default).
  - **Dashboard:** a date range (This month by default, Last 30 days, All time or custom), GMV, margin earned and processing fee tiles, the all-time amount owed to the provider (`owedToYouCents`, the provider's payable balance), "See paid orders →" and "See orders awaiting payment →" links into the Orders tab, a **Sold by product** table for the range (units sold and revenue per product from the provider's paid orders, by revenue; `soldByProduct`, revision 18.3), and a searchable, read-only inventory.
  - **Default patient prices** (revision 20): every provider has a default price for every product, starting at the minimum (`minUnitPriceCents(cost)`). `GET /api/products` returns it as `defaultUnitPriceCents`; `PUT /api/products/:id/default-price` sets it (an integer from the minimum to 1,000,000 cents) and `POST /api/products/:id/default-price/reset` returns it to the minimum. It is provider-only, never in a patient response, and only pre-fills new order lines: lines keep their own price.
  - List filters, searches and pages are kept in the URL, so reload, Back and shared links restore the same view.
- **Patient** (nav: My Orders): sees sent orders and pays them, in full or, when stock is short, for the in-stock items. Never sees wholesale cost, margin or the fee.
- **Admin** (nav: Inventory | Accounts): adds to or sets product stock under Inventory, and reads the ledger under Accounts: a trial balance of every account (`GET /api/admin/accounts`) and the journals, newest first (`GET /api/admin/journals`), each showing its order number as plain text and its provider. Accounts also lists **payments needing attention** (`GET /api/admin/payment-attempts`), each with a Reconcile action, and a Refund action for a charge that must be refunded (revisions 18.2 and 19.1, see [Stranded payments](#stranded-payments)). The admin screens and endpoints carry no patient data; provider names appear on payables, journals and payment attempts. The one exception, for every visitor and not only the admin, is the public sign-in screen: it lists a few demo patient personas by name (fictitious data), because the stubbed sign-in has to offer them. That is a demo-only exposure accepted with the stub auth (see [Signing in](#signing-in)).
- Page content is centered in a max-width column on wide screens.

### Deviation from the PRD

FR5 says providers update inventory. Here inventory is managed by an **admin** role instead, at the product owner's decision (revision 13): providers see stock read-only on their dashboard, alongside what they have sold by product, and the admin adds to or sets stock. Everything else about stock (reservations on pay, back-orders, the audit trail) is unchanged by who edits it.

## Quickstart

Prerequisites: Node, npm, and Docker. Node 22 is the supported version (`.nvmrc`; `nvm use`); CI and Railway use it. `engines` in `package.json` is `>=22.13 <23`.

`npm ci` and `npm install` from the committed lockfile work on npm 10. Changing the Vitest version is different: npm 10.9 crashes while resolving Vitest 4, so regenerate the lockfile with npm 11 (for example `npx npm@11 install`).

```sh
npm install
npm run db:up        # Postgres 16 in Docker on localhost:54329; waits until healthy
npm run db:migrate   # applies migrations 0000-0018 (includes the pg_trgm extension)
npm run db:seed      # wipes the dev database and loads the demo seed
npm run dev          # API on http://localhost:3000, web on http://localhost:5173
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the API. `GET /api/health` returns 200 when the API can reach Postgres.

The API defaults `DATABASE_URL` to the Docker database (`postgres://supplement_orders:supplement_orders@localhost:54329/supplement_orders`). To override it or `PORT`, copy `apps/api/.env.example` to `apps/api/.env`.

### Signing in

Authentication is stubbed, as the PRD allows; the sign-in screen labels the list "Demo personas (fictitious data)". The `/login` dropdown lists the curated demo personas from `GET /api/users/sign-in-options`: each provider followed by their first two patients in name order, then the admin, with only an id, name and role each. Pick one and click **Sign in**; there is no password. The role comes from the user record on the server, never from the client. A reload restores the session from `GET /api/users/me`, which returns only the signed-in user; there is no endpoint that lists every user or patient. The list is public, so anyone who opens the sign-in screen sees those patient persona names; with stub auth that is accepted for the demo, and all of it is fictitious.

Which patients appear depends on the seed. With the demo seed (`npm run db:seed`, and the live demo) the 250 generated patients sort first, so the personas are:

| User            | Role     | Use it to                                                               |
| --------------- | -------- | ----------------------------------------------------------------------- |
| Dr. Maya Rivera | Provider | Build and send orders for Avery Abbott or Avery Castillo, the dashboard |
| Avery Abbott    | Patient  | Pay an order Dr. Rivera sent                                            |
| Avery Castillo  | Patient  | Dr. Rivera's second listed patient                                      |
| Dr. Owen Brooks | Provider | A second provider, to see that providers can't see each other's data    |
| Alex Kim        | Patient  | One of Dr. Brooks's patients                                            |
| Avery Fischer   | Patient  | Dr. Brooks's second listed patient                                      |
| Ada Admin       | Admin    | Manage stock under Inventory, read the ledger under Accounts            |

The small named seed that the tests and e2e use (`npm run e2e:db`) has no generated patients, so there Dr. Rivera's patients are Jordan Lee and Sam Patel, and Dr. Brooks's are Alex Kim and Riley Chen.

`npm run db:seed` loads the demo seed: 12 products with small stock so stock changes are easy to check by hand (Probiotic 50 Billion CFU at 0; Omega-3, CoQ10 and N-Acetyl Cysteine at 1-3; the rest at 5-25), and 250 generated patients split between the two providers, so patient search and pagination have something to page through. The first five products are the named ones the tests and e2e use, with the same ids and costs; only their stock differs (the test and e2e seed keep 25-120). A few generated patients share a name and a provider and differ by date of birth and address. Every seed also has the ledger's system accounts and one payable account per provider.

A demo path (demo seed or live demo): sign in as Dr. Maya Rivera, search Patients for Avery Abbott and open the patient, click **New order**, add a product through **Add line**, set Markup % or Patient price, **Send to patient**. Sign out, sign in as Avery Abbott, open the order under My orders and click **Pay**. Sign back in as Dr. Rivera to see the order's journal, find it under Orders, and check the dashboard. On the live demo, other visitors may have created orders too.

The patient pay screen has no failure control. Outside production the API accepts `simulateFailure: true` on the pay request (the e2e test adds it to the request). A simulated decline records no payment and no journal, and gives back the stock the attempt had reserved. The order stays payable; paying again starts a new attempt with a new idempotency key. Idempotency keys are `<installId>-order-<id>-r<revision>-e<execution>`, where `installId` is a UUID each database generates once (migration 0016), so two environments sharing a processor account can't collide; keys of attempts made before revision 18 keep their old form. A new execution (`e<n+1>`) starts only after a definitive decline from the gateway, never after a timeout or an abandonment (revision 19.1).

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
| `npm run e2e:db`                     | Creates, migrates and resets the `supplement_orders_e2e` database to the small named seed                                                                    |
| `npm run e2e:api`                    | API on port 3100 against `supplement_orders_e2e`                                                                                                             |
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
- **No $0 orders** (revision 17.2). A $0 line is allowed (a free sample of a product with no wholesale cost), but an order whose total is $0.00 can't be sent (400 `VALIDATION_ERROR` on `lines`), and pay refuses a payable total of 0 with 409 `ORDER_CHANGED` before reserving stock or charging anything.
- **Markup %** in the order builder is the provider's net markup on wholesale cost after the fee: `(price - cost - 0.0075 * price) / cost`. It's uncapped and linked both ways with the patient price. 0% means the minimum price.

Worked example: a product with a $5.81 wholesale cost has a minimum price of $5.86. At $5.86 the fee is 75 bps of $5.86 = 4.395 cents, rounded up to $0.05, so cost + fee = minimum and the provider margin is $0.00. At $120.00 against $70.00 wholesale, the fee is exactly $0.90 and the provider keeps $49.10.

### Double-entry ledger

Revision 16 replaces the three `ledger_entries` rows per payment with a double-entry ledger (migration 0014). Amounts are signed integer cents: positive is a debit, negative a credit.

| Account                                 | Type      | Normal balance |
| --------------------------------------- | --------- | -------------- |
| `1000` Cash                             | asset     | debit          |
| `2100-<providerId>` Payable to provider | liability | credit         |
| `4000` Product sales at wholesale cost  | revenue   | credit         |
| `4100` Platform fee revenue             | revenue   | credit         |

When the patient pays, the finalize transaction posts one `patient_payment` journal: Cash debit of the amount paid, and credits of the cost of goods, the provider's margin and the fee. A zero amount is omitted, so an order at minimum prices has no payable posting. The database enforces it: accounts, journals and postings are append-only (only an account rename is allowed), every journal must balance with at least two non-zero postings at commit, and every payment must have exactly one journal whose Cash debit equals the payment and whose credits go only to that order's provider payable and the two revenue accounts. Since migration 0015 (revision 17.3) the database also checks the split itself: the Product sales credit equals the order lines' quantity times their wholesale cost snapshots, the fee credit equals the order's stored fee, the payable credit is the rest, and the payment must come from a succeeded payment attempt on the same order. Since migration 0017 (revision 19.2) the payment's amount, idempotency key and gateway reference must equal that attempt's, and the attempt's revision the order's. Each provider's payable account is created by a trigger in the same statement as the provider. The provider's order detail shows the journal, and its split is read from the postings. The dashboard reads the postings too: GMV is the Cash debits on the provider's payment journals, margin the credits to its payable, fees the platform fee credits, and **Owed to you** the payable's all-time balance. Admins see a trial balance whose total debits equal total credits, and the journal list.

Pay is bound to the quote the patient saw: the request carries the order's `revision` and total, and a stale screen gets 409 `ORDER_CHANGED` and isn't charged. Each charge goes through a durable payment attempt that reserves stock first and has its own idempotency key, and the gateway charges a key at most once. So a retry, a restart, a timeout, or an admin's abandonment followed by a retry of the same quote can't charge twice: they all reuse the key. The one way to charge twice is a gateway call delayed past the 15-minute abandonment window that lands after the provider re-sent the order at a new revision; it is always recorded and listed for the admin to refund (see [Stranded payments](#stranded-payments)). Once a payment records an attempt, a database trigger freezes that attempt against any change or delete (revision 18.4). The full sequence is in [Architecture §6](docs/ARCHITECTURE.md#6-core-flow).

### Stranded payments

If the gateway call throws (a transport error or a timeout), the outcome is unknown. The attempt stays `pending`, its stock stays held, and pay answers 503 `PAYMENT_PENDING` with `{ orderId, revision, amountCents }`; the patient sees "Your payment is being processed" and **Complete payment**, which retries the same key and can't charge twice (revision 18.2). If the patient never comes back, an admin can settle it from **Payments needing attention**: `GET /api/admin/payment-attempts?status=unresolved` lists attempts that are pending, succeeded without a payment, in conflict, a late success, or a charge still to be refunded (attempt id, order id, provider, amount, status, age, gateway reference, refunded at; no patient data), and `POST /api/admin/payment-attempts/:id/reconcile` asks the gateway's `lookup`, which never charges:

- the gateway has a success: the payment and journal are recorded exactly as a retry would, with no new charge;
- the gateway has a decline: the attempt is declined and its stock released;
- the gateway has no record and the attempt is more than 15 minutes old: the attempt is marked `abandoned` and its stock released. Its key is not retired (revision 19.1): the patient's next pay re-runs the same execution with the same key and takes the stock again, so if the original call was only delayed, the gateway charges once and both requests see that one charge;
- otherwise: 409 `RECONCILE_TOO_EARLY`.

Reconciling is idempotent (`outcome: 'unchanged'` when there is nothing left to do), each reconciled attempt records when and by whom, and stock released this way is written to `inventory_adjustments` as `reconcile_release`, naming the attempt.

**Late successes** (revision 19.1). A gateway success for an execution that is no longer current (abandoned, or its order paid, cancelled or re-sent since) is recorded on its attempt as `late_success`, with its amount and reference, and listed under Payments needing attention. Reconciling it pays the order with that charge if the order still awaits payment at the same quote and the stock is there (`finalized`); otherwise it becomes `refund_required` (`outcome: 'refund_required'`), shown as "Charged twice: refund $X" until an admin marks it refunded with `POST /api/admin/payment-attempts/:id/refund`. Real refunds are out of scope: the fake gateway's `refund(key)` stub records the refund. Before a re-sent order's new revision gets its first key, every abandoned key from an earlier revision is looked up; if the gateway has a charge for it, that charge is recorded as `late_success` and the pay is 409 `PAYMENT_NEEDS_RECONCILIATION` until an admin settles it.

### Stock

An admin (Ada Admin) manages stock (revision 13, at the product owner's request; this reverses the earlier reading that stock is never edited by hand, and is the [deviation from the PRD](#deviation-from-the-prd)). Providers and patients can't change it, and the provider dashboard's inventory stays read-only. The admin can add to a product's stock (an atomic increment, so concurrent additions never conflict) or set it to an exact value. Setting is a compare-and-set against the value the admin loaded: if a payment reserved stock or another admin changed it in the meantime, the API answers 409 `STOCK_CHANGED` with the current value and changes nothing. An admin sets stock to a value between 0 and 1,000,000. A declined payment gives its reservation back without clamping, so stock can briefly sit above the bound; the set's expected value may be any non-negative integer, so it can always be corrected (revision 15.4). Every admin change is recorded in an append-only `inventory_adjustments` table, as is stock an admin's reconcile releases (`reconcile_release`). The admin edits available stock, the same number the dashboard shows. A pay attempt reserves the order's quantities before charging, a decline gives them back, and a recorded payment keeps them as the sale. So an order whose payment is in progress, or waiting for reconciliation, already counts against the stock shown.

### Low stock and back-orders

Revision 14 lets a provider send quantities above the stock available now: the builder warns, saving is never blocked, and send asks for an explicit acknowledgement (`acknowledgeLowStock`). Stock is still reserved only when the patient pays.

- **Awaiting stock.** An order awaiting payment none of whose lines is in stock shows as **Awaiting stock**. This status is derived, not stored: the `orders_with_status` view computes it from current stock on every read, so restocking or a sale is reflected immediately.
- **Paying for what's in stock.** The patient sees what is payable now. Paying in full with any shortfall is refused (409 `INSUFFICIENT_STOCK`). Choosing to pay for the in-stock items (`mode: 'available'`) charges exactly the in-stock total the patient saw, and in the same locked transaction moves the shortfall to one new **back-order** at the original unit prices. The paid order and its back-order link to each other. If stock moved in the meantime, the patient gets 409 `ORDER_CHANGED` with the refreshed amounts and nothing is charged.
- **Chains.** A back-order is paid like any order, and partially paying it creates the next back-order. Retrying the same request, even after a restart, never splits or charges twice.
- **Lifecycle.** A back-order can be cancelled but never edited or reopened (409 `BACKORDER_NOT_EDITABLE`).
- **Fees are conserved** (revision 18.4). A split charges the in-stock portion 75 bps of its subtotal rounded up (never more than the order's own fee), and the back-order keeps the rest of the original fee. The fees across a whole chain add up to exactly the fee of the unsplit order, and no part's margin goes negative. For example, an order with a 17¢ fee splits into 9¢ and 8¢.
- **Quote binding** (revision 15.2). Paying for the in-stock items sends `expectedPayableLines`, the exact in-stock products and quantities on screen. If the server's plan names different lines, even at the same total, the answer is 409 `ORDER_CHANGED` with the refreshed quote (`error.partialPaymentQuote`) and nothing is charged. A full pay with a shortfall gets the same quote with 409 `INSUFFICIENT_STOCK`.
- **Chains** (revision 15.3). A back-order can't be paid until the order it came from is paid (409 `PRIOR_ORDER_UNPAID`); the patient sees "Pay order #A first" with a link. Cancelling an order cancels its whole downstream chain, all or nothing: if any order in it has a payment in progress, nothing is cancelled. Deleting a reopened draft deletes its cancelled back-orders too.
- **Only live back-orders count** (revision 18.1). An order has at most one back-order that isn't cancelled (a partial unique index, migration 0016); cancelled ones stay as history. Reopening a cancelled original merges its cancelled back-orders' lines back into the draft (quantities added at the original line's price), so the provider gets the whole order back and a resent order can split again. An order that already has a live back-order and is short again, even with nothing in stock, gets a quote with `payable: false` and `reason: 'awaiting_restock'`; it can be paid once restocked. Every payable quote the detail endpoint offers can be paid by sending it back unchanged.
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

Deploys run from GitLab CI: every push to `main` runs the `deploy` job in [`.gitlab-ci.yml`](.gitlab-ci.yml), which installs the Railway CLI and runs `railway up --ci --service web`, authenticated by `RAILWAY_TOKEN`, a Railway project token stored as a masked CI/CD variable. (Railway's own repo auto-deploy only supports GitHub, and this repository is hosted on GitLab.) Running `railway up` from the repo root on an up-to-date `main` still works for a manual deploy.

**Auth is stubbed on the public demo too.** Anyone with the URL can sign in as any seeded user and create, pay or cancel orders. All the data is fake.

**CI** (revisions 18.4 and 19.4). Every pipeline runs two jobs in parallel on the same `railway-deploy` runner, each with a `postgres:16` service using the same credentials as `docker-compose.yml`. `test`, in `node:22`: `npm ci`, lint, typecheck, `npm test` and build. `e2e`, in the official Playwright image for the project's Playwright version (`mcr.microsoft.com/playwright:v1.63.0-noble`, browsers preinstalled, so nothing is downloaded per run): `npm ci` and `npm run test:e2e`, serially with 2 retries, bounded by a 20-minute timeout, with traces kept as artifacts on failure. `deploy` needs both, so `main` deploys only after the unit, integration and end-to-end suites pass. Bump the image tag together with `@playwright/test`.

## What's stubbed

| Concern          | Stub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments         | `FakePaymentGateway` stands in for a processor with durable idempotency. It keeps every charge in its own table, `fake_gateway_charges`, written in its own committed statements. The first call for a key decides the outcome; later calls with the same key and amount replay it, a different amount is refused, and `lookup` never charges. `refund(key)` only records a refund on the stored charge (revision 19.1). It always succeeds unless failure is forced: `{ simulateFailure: true }` on the pay request forces a decline unless `NODE_ENV` is `production` |
| Auth             | The login screen stores the chosen user id in localStorage; the client sends it as `X-User-Id`. `HeaderAuth` looks the user up and takes the role from the database. Unknown or missing id is a 401. `GET /api/users/me` returns the caller; the public `GET /api/users/sign-in-options` lists only the demo personas. No passwords or sessions. Another practice's or patient's order or patient is a 404, the same as one that doesn't exist, so ids can't be probed (revision 18.4)                                                                                  |
| Notifications    | `ConsoleNotifier` logs `[notifier] order <id> is ready for patient payment` and `[notifier] order <id> was cancelled by the provider` to the API console                                                                                                                                                                                                                                                                                                                                                                                                                |
| Shipping and tax | Not modeled. The patient's address is shown as a plain string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Each stub sits behind an interface in `apps/api/src/seams/` and is injected through `createApp`, so a real implementation replaces the fake without touching domain code.

## Testing

| Suite                                         | Count              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain` (Vitest)                    | 407 in 15 files    | Fee, minimum price, split, partial-payment planning, conserved split fees and the awaiting-restock quote, journal balance and split round trip, markup conversions, money parsing and formatting, request schemas and draft bounds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/api` (Vitest + Supertest)               | 603 in 57 files    | Against a real Postgres: revision 18 fixes (live back-orders and reopen merging, honest quotes that round-trip, 503 `PAYMENT_PENDING` and admin reconcile with an injected clock, sold by product, install-scoped keys, conserved split fees, 404 for not-yours, frozen paid attempts, the 100-line limit), revision 17 fixes (no user directory, `/api/users/me` and trimmed sign-in options, zero-total send and pay, the 0015 journal split and provenance check including over existing data), revision 16 double-entry ledger (database guards, the real 0013 to 0014 backfill on a scratch database, trial balance, journal list, owed to you), revision 15 fixes (held-stock recovery after a failed finalization and restart, payable-line approval, chain cancel and delete, pay order in a chain, stock correction above the bound, frozen paid orders and their lines), revision 14 back-orders (derived awaiting stock, full and partial pay, stale quotes, replay across a restart, concurrent splits, chains, back-order lifecycle, send acknowledgement), HTTP contract tests, stale-quote and payment-integrity tests (fenced outcomes, overlapping and held gateway responses, key conflicts, restart recovery with a fresh gateway and app on the same database), concurrent pay/cancel, delete and reopen, admin stock (concurrent increments, compare-and-set racing a payment reservation, audit rows), order list filters, search, dashboard snapshot, SPA serving |
| `apps/web` (Vitest + Testing Library + jsdom) | 354 in 35 files    | Views and components, 16 axe-core accessibility scans, 23 loading/error/empty/persona state tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `e2e/` (Playwright)                           | 11 files, 27 tests | Admin stock, back-orders (partial pay, chains, restock, stale quote, filters), dashboard range, happy path (order, pay, journal, exact dashboard and stock deltas), simulated gateway failure, revision 18 (partial pay after cancel and reopen, admin reconciles a stranded payment), cancel, order lifecycle (delete draft, cancel, reopen, status filters), a stale patient page that must reload before paying the new total, URL-state navigation (4 cases)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Counts are from `npm test` and `npm run test:e2e` at the time of writing.

- The API tests use their own database on the same Postgres server, created on first run and truncated per test. Each checkout gets its own test database (from `TEST_DATABASE_NAME`, else `AO_SESSION_ID`, else a hash of the repo path), so parallel checkouts don't interfere. `TEST_DATABASE_URL` overrides it.
- The axe scans run in jsdom with WCAG 2.0/2.1 A and AA plus best-practice rules. `color-contrast` is disabled there because jsdom can't compute styles.
- Web tests follow Testing Library conventions (`screen` queries, `user-event`, jest-dom matchers), enforced by `eslint-plugin-testing-library`. End-to-end tests use only Playwright's role, label and text locators.
- Tests were written test-first, mostly by a different model from the one that wrote the implementation. See [AI usage](docs/AI_USAGE.md).

## Repository layout

```
packages/domain       @supplement-orders/domain: money logic (split, fee, minimum price, markup, journal,
                      format/parse) and the shared API types and Zod schemas. Consumed as
                      TypeScript source, no build step
apps/api              Express REST API
  src/http/           routes, error mapping, production SPA serving, HTTP contract tests
  src/orders/         order service (send, pay, cancel, delete, reopen, reconcile) and read views
  src/payments/       the admin's payment-attempt list
  src/seams/          Auth, PaymentGateway, Notifier interfaces and fakes
  src/ledger/         double-entry journals: posting a payment, reads, trial balance
  src/db/             Drizzle schema, migration runner, seed, test/e2e database helpers
  drizzle/            SQL migrations 0000-0018
  scripts/            explain-search.ts
apps/web              Vue 3 + Vite + PrimeVue SPA (views, components, api client, a11y and state tests)
e2e/                  Playwright specs
docs/                 Architecture, decisions, AI usage, screenshots
```
