# Architecture

This describes the system as it stands now. The reasoning behind each choice, including the ones that were reversed along the way, is in [DECISIONS.md](DECISIONS.md).

## 1. Goals and non-goals

**Goals**

- A provider assembles an order for a patient and sets the patient-facing price per item.
- The patient pays through a stubbed payment step.
- Every paid order is split into wholesale cost (COGS), provider margin and a 75 bps platform fee. The three parts sum exactly to the amount paid.
- A paid order is auditable from stored data alone: every cent is attributed to one of those three buckets in an append-only ledger.
- A provider dashboard shows orders awaiting payment, what has sold, and current stock. Stock is never edited by hand; it decreases when an order is paid.
- GMV and platform fee revenue are directly queryable.

**Non-goals** (from the brief)

- Real payments, auth, email, shipping or fulfillment.
- Tax, shipping cost, regulatory compliance, multi-state or international handling.
- Warehouse or multi-location inventory.
- Refunds. Cancelling is supported only for orders that haven't been paid.

## 2. Principles

1. **The money path comes first.** The split must be correct, deterministic and verifiable from stored rows.
2. **Clean seams for everything external.** Payments, auth and notifications are small interfaces with fake implementations, injected at startup.
3. **One home for the money rules.** The split, fee, minimum price and markup conversions live in `@supplement-orders/domain`, and both the API and the browser call the same functions.
4. **Smallest thing that proves the flow.** One API, one SPA, one database.

## 3. Stack

| Concern        | Choice                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Language       | TypeScript everywhere                                                                             |
| Front end      | Vue 3 (Composition API, `<script setup lang="ts">`), Vite 7, Vue Router, PrimeVue 4 (Aura preset) |
| API            | Node, Express 5, Zod 4 for request and response validation                                        |
| Database       | Postgres 16 (Docker locally), `pg_trgm` for substring search                                      |
| ORM/migrations | Drizzle ORM and drizzle-kit; SQL migrations are committed                                         |
| Tests          | Vitest 3, Supertest, Vue Testing Library, user-event, jest-dom, axe-core, Playwright              |
| Tooling        | npm workspaces, ESLint (encodes the code style rules), Prettier                                   |

The domain package is consumed as TypeScript source with no build step. The API runs under `tsx` in development and has no compile step yet. Vitest is pinned to 3.x because every Vitest release from 4 on crashed the npm 10.9 dependency resolver on the development machine.

## 4. Domain model

| Entity        | Key fields                                                                                                                | Notes                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `User`        | `name`, `role` (`provider` or `patient`)                                                                                  | A user has exactly one role, stored on the record. The client never asserts a role                                                    |
| `Provider`    | `userId` (unique)                                                                                                         | One-to-one profile for a provider user. Receives margin                                                                               |
| `Patient`     | `userId` (unique), `providerId`, `dateOfBirth`, `address`                                                                 | Belongs to one provider. Name plus date of birth is how a provider tells patients apart                                               |
| `Product`     | `sku` (unique), `name`, `cogsCents` (wholesale cost), `stockQuantity`                                                     | Stock is only decremented by a successful payment                                                                                     |
| `Order`       | `providerId`, `patientId`, `status`, `subtotalCents`, `platformFeeCents`, `totalCents`, `sentAt`, `paidAt`, `cancelledAt` | Totals are snapshotted when the order is sent                                                                                         |
| `OrderItem`   | `productId`, `quantity`, `unitPriceCents`, `unitCogsCents`                                                                | Draft lines may lack a product or a price. Cost is snapshotted on the line, so later catalog changes never alter a sent or paid order |
| `Payment`     | `orderId` (unique), `amountCents`, `idempotencyKey` (unique), `gatewayReference`                                          | At most one per order                                                                                                                 |
| `LedgerEntry` | `orderId`, `paymentId`, `type` (`cogs`, `provider_margin`, `platform_fee`), `amountCents`                                 | Exactly three per payment, unique on `(paymentId, type)`. Append-only                                                                 |

Order status lifecycle:

```
draft ──send──> pending_payment ──pay──> paid
  │                   │
  └──cancel──> cancelled <──cancel──┘
```

Why a ledger rather than three columns on the order: "where did every cent go" becomes a query over append-only rows, GMV and fee revenue are a `SUM` grouped by entry type, and future adjustments (refunds, corrections) can be new entries instead of mutations.

Database constraints back the model:

- Every money column is `bigint` cents. `products.cogs_cents`, `order_items.unit_price_cents`, `order_items.unit_cogs_cents`, `payments.amount_cents` and `ledger_entries.amount_cents` have a `>= 0` check. The three order totals (`subtotal_cents`, `platform_fee_cents`, `total_cents`) don't; their non-negativity is an application invariant.
- `orders_total_is_subtotal`: the patient total equals the subtotal. This constraint was added `NOT VALID` so rows from before that rule are left alone; every new or updated row is checked.
- `orders_fee_within_subtotal`, `orders_paid_at_iff_paid`, `orders_cancelled_at_iff_cancelled`, `orders_sent_unless_draft_or_cancelled`, and `orders_totals_present_once_sent`.
- `order_items`: quantity `>= 1`, one line per product per order, and a cost snapshot exactly when a product is set.
- Unique `payments.order_id`, unique `payments.idempotency_key`, unique `ledger_entries(payment_id, type)`.

Ledger immutability is enforced by the application: there is no update or delete path for `ledger_entries`. There is no database trigger preventing it.

## 5. Money model

All amounts are integer cents in USD. The functions below are in `packages/domain/src/money/`.

| Rule              | Definition                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient total     | `total = subtotal = sum(quantity * unitPriceCents)`. The patient pays exactly what the provider priced                                          |
| Processing fee    | `computePlatformFee(subtotal) = floor((subtotal * 75 + 9999) / 10000)`: 75 bps of the subtotal, rounded up to the cent, once per order          |
| Provider margin   | `subtotal - cogs - fee`                                                                                                                         |
| Minimum price     | `minUnitPriceCents(cost)`: the smallest price `p` with `p - cost >= ceil(75p / 10000)`, which equals `cost + ceil(75 * cost / 9925)`            |
| Markup %          | `markupBpsFromPrice(cost, price) = (9925 * price - 10000 * cost) / cost` in basis points, rounded half up. `null` when cost is 0                |
| Price from markup | `priceFromMarkupBps(cost, k) = max(roundHalfUp(cost * (10000 + k) / 9925), minUnitPriceCents(cost))`. Uncapped. `k = 0` gives the minimum price |

Properties the tests hold the code to:

- `cogs + providerMargin + platformFee === total`, and `total === subtotal`.
- If every line is at or above its minimum price, `providerMargin >= 0`. The order-level fee rounded up is never more than the sum of per-unit fees rounded up, which the minimum price already covers.
- For every cost, `cost + computePlatformFee(minUnitPriceCents(cost)) === minUnitPriceCents(cost)`. The fee the UI shows at the minimum price reconciles with the minimum exactly.
- The result doesn't depend on line order.
- Any value that would exceed `Number.MAX_SAFE_INTEGER`, including the fee's intermediate `subtotal * 75 + 9999`, is rejected as `UNSAFE_AMOUNT` rather than risking a wrong cent.

Why each rule:

- **Integer cents:** floats can't represent cents exactly.
- **Fee on the subtotal, not per line:** computing per line and summing accumulates rounding error.
- **Fee rounded up:** the minimum price has to round the per-unit fee up. If it rounded half up, two $0.66 lines priced at $0.66 would produce a $0.01 order fee on $1.32 and a margin of -$0.01. Using the same rounding for the charged fee makes the displayed numbers reconcile (a $5.81 cost has a $5.86 minimum, and the fee shown at $5.86 is $0.05). The platform collects at most one cent more per order than half-up rounding would.
- **Markup uses the exact 0.75% rate,** not the rounded cent fee, so the percentage depends only on price and cost, not on quantity.

The ledger functions build and check the entries:

- `toLedgerEntries(split)` returns exactly three entries in the order `cogs`, `provider_margin`, `platform_fee`. Zero amounts are still emitted.
- `assertLedgerBalances(entries, amountPaid)` throws `LedgerImbalanceError` unless there are three non-negative integer entries, one of each type, summing to the amount paid.

## 6. Core flow

1. **Create a draft.** `POST /api/orders` with a `patientId` the provider owns.
2. **Edit lines.** `PUT /api/orders/:id/lines` replaces all lines. Drafts are lenient: a line may omit the product or the price, and a price may be below the minimum. Save returns 400 for a non-integer, a quantity below 1, or a negative price, and 422 for a duplicate or unknown product. Completeness, stock and the minimum are enforced on send. The builder shows a live split computed with the shared `computeSplit` once all lines are complete.
3. **Send.** `POST /api/orders/:id/send`, in one transaction:
   - lock the order row (`SELECT ... FOR UPDATE`) and require it to be the caller's draft;
   - require at least one line (`EMPTY_ORDER`), every line complete (`INCOMPLETE_LINE`), enough stock (`INSUFFICIENT_STOCK`), and every price at or above its minimum (`PRICE_BELOW_MINIMUM`, from `computeSplit`);
   - re-snapshot each line's wholesale cost from the product, and store the subtotal, fee and total on the order;
   - set the status to `pending_payment` and record `sentAt`.

   After commit, the notifier is called. A notification failure is logged and doesn't undo the send.

4. **Pay.** `POST /api/orders/:id/pay` by the patient, in one transaction:
   1. lock the order row `FOR UPDATE`. If it's already `paid`, return the existing result without charging again. If it was never sent, respond 404. If it was sent but isn't `pending_payment`, respond 409 `ORDER_NOT_PAYABLE`;
   2. recompute the split from the snapshotted lines with `computeSplit`, and abort if it doesn't reproduce the stored total;
   3. decrement stock for each line with a conditional update (`stock >= quantity`). This happens **before** the charge, so every expected failure (such as insufficient stock) happens before money moves;
   4. charge the `PaymentGateway` with the idempotency key `order-<id>-payment`. A decline is a 402 `PAYMENT_FAILED`;
   5. insert the `Payment`;
   6. build the three ledger entries, assert they sum to the payment amount, and insert them;
   7. mark the order `paid` with `paidAt`.

   Any error rolls back the whole transaction: no payment, no ledger rows, no stock change. Concurrent pays serialize on the row lock, and the loser sees `paid` and returns the same result. The unique constraints on `payments.order_id` and `ledger_entries(payment_id, type)` back this at the database level.

   The charge happens inside the database transaction. If the transaction fails after a successful charge, a retry reuses the same idempotency key, and the fake gateway replays the original result instead of charging twice. A production integration would also need reconciliation for a charge whose transaction never committed and was never retried (see §12).

5. **Cancel.** `POST /api/orders/:id/cancel` by the provider, for `draft` or `pending_payment` orders only. It takes the same row lock as pay, so a cancel and a pay can't both succeed; the loser gets a 409 (`ORDER_NOT_CANCELLABLE` or `ORDER_NOT_PAYABLE`). Cancelling writes no ledger entries and doesn't touch stock. The patient is notified only if the order had been sent. A draft cancelled before sending stays invisible to the patient.
6. **Read.** The provider's order detail shows the snapshotted lines, the split, the payment reference and the three ledger entries with a "Total of entries" check. The patient's view has its own DTO type with no cost, margin, fee or ledger fields, so those can't leak by accident.

## 7. Seams

All three are interfaces in `apps/api/src/seams/`, passed to `createApp(deps)`. Tests inject their own (for example a `RecordingNotifier`, or test-only hooks inside the pay transaction to prove rollback after the ledger insert).

| Seam             | Interface                                                                                                              | Fake                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentGateway` | `charge({ amountCents, idempotencyKey, description }, { simulateFailure? }) -> { reference, status, failureMessage? }` | `FakePaymentGateway`: succeeds with a `fake_ch_<uuid>` reference, replays the stored result for a repeated key, fails when forced. The API ignores `simulateFailure` when `NODE_ENV` is `production` |
| `Auth`           | `getCurrentUser(req) -> { userId, role, providerId, patientId? }`                                                      | `HeaderAuth`: reads `X-User-Id`, loads the user and their provider or patient profile, and takes the role from the database. Missing, malformed or unknown id is 401                                 |
| `Notifier`       | `notifyPatientOrderReady(orderId)`, `notifyPatientOrderCancelled(orderId)`                                             | `ConsoleNotifier` logs to the console                                                                                                                                                                |

Shipping isn't modeled; the patient's address is a plain string.

## 8. Metrics

- **GMV** is the sum of `payments.amount_cents` for the provider's paid orders: what patients actually paid.
- **Margin earned** and **processing fees** are sums of the `provider_margin` and `platform_fee` ledger entries.

The dashboard reads the audited rows rather than recomputing anything. Cancelled and unpaid orders contribute nothing because they have no payment or ledger rows. There's no date filter in the UI; the queries are a `WHERE` clause away from one. Platform-wide fee revenue is a `SUM` over `platform_fee` entries, but it isn't exposed anywhere because there's no admin persona.

## 9. API

Every endpoint except `/api/health` and `/api/users` requires `X-User-Id`. Application errors use `{ error: { code, message, field? } }`, where `field` is a dotted path into the request body (for example `lines.1.unitPriceCents`) so the UI can place the message next to the input. Money fields are integer cents with a `Cents` suffix. Health is the exception to the error envelope: it returns `{ status, db }`, with 503 when Postgres is unreachable.

| Method and path                                         | Who      | Purpose                                                                                                  |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                       | anyone   | 200 if Postgres is reachable, 503 otherwise                                                              |
| `GET /api/users`                                        | anyone   | Seeded users for the login screen                                                                        |
| `GET /api/products?q=&offset=&limit=`                   | provider | Paginated catalog search by name or SKU                                                                  |
| `GET /api/patients?q=&offset=&limit=`                   | provider | The provider's patients. Name substring, or exact date of birth when `q` is `MM/DD/YYYY` or `YYYY-MM-DD` |
| `GET /api/patients/:id`                                 | provider | Patient detail                                                                                           |
| `GET /api/orders?patientId=`                            | both     | Orders visible to the caller, as an array. Patients never see unsent orders                              |
| `GET /api/orders?status=pending_payment&offset=&limit=` | provider | Awaiting payment, oldest sent first, paginated                                                           |
| `POST /api/orders`                                      | provider | Create a draft (201)                                                                                     |
| `GET /api/orders/:id`                                   | both     | Provider view (lines, split, payment, ledger) or patient view (lines and total)                          |
| `PUT /api/orders/:id/lines`                             | provider | Replace a draft's lines                                                                                  |
| `POST /api/orders/:id/send`                             | provider | Draft to `pending_payment`                                                                               |
| `POST /api/orders/:id/pay`                              | patient  | Pay. Body may be `{ "simulateFailure": true }` outside production                                        |
| `POST /api/orders/:id/cancel`                           | provider | Cancel a draft or pending order                                                                          |
| `GET /api/dashboard`                                    | provider | GMV, margin, fees, and paid orders with their splits                                                     |

Status codes: 400 `VALIDATION_ERROR`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` (wrong persona or someone else's resource), 404 `NOT_FOUND`, 409 wrong order status (`ORDER_NOT_DRAFT`, `ORDER_NOT_PAYABLE`, `ORDER_NOT_CANCELLABLE`), 422 business rules (`EMPTY_ORDER`, `INCOMPLETE_LINE`, `PRICE_BELOW_MINIMUM`, `INSUFFICIENT_STOCK`, `DUPLICATE_PRODUCT`, `UNKNOWN_PRODUCT`, and the other split codes), 402 `PAYMENT_FAILED`, and 500 `INTERNAL` for an unexpected failure, including a sent order whose lines no longer reproduce the stored total.

Request and response types are TypeScript interfaces in `packages/domain/src/api/`, each paired with a Zod schema typed against the interface so the two can't drift. The web app imports the same types.

## 10. Search and pagination

- Products and patients use offset pagination returning `{ items, total, offset, limit }`. The default limit is 25 and the maximum 100. Ordering is by name, then id, so pages are stable.
- Search is a case-insensitive substring match (`ILIKE '%q%'`) with `%`, `_` and `\` escaped, so they match literally. Products match name or SKU. Patients match name, plus an exact date of birth when the whole query is a valid date. Address is deliberately not searched.
- A btree index can't serve a substring match, so migration `0005` enables `pg_trgm` and adds GIN trigram indexes on `products.name`, `products.sku` and `users.name`. The queries `ILIKE` the bare columns, which is what those indexes match.
- `npm run explain:search -w apps/api` loads 50,000 products and 20,000 patients into a throwaway database and prints the query plans before and after the trigram indexes. In one local run, a selective product name search went from about 38 ms (sequential scan) to about 0.2 ms (bitmap index scan on the trigram index), and the matching count query from about 40 ms to about 0.1 ms. A common term such as "ashwagandha" doesn't benefit on the first page, because a page of 25 is found quickly by walking the name index. Its count query still dropped from about 44 ms to about 5 ms. Timings vary by machine.
- The awaiting-payment list uses a `(provider_id, status, sent_at, id)` index.

## 11. Testing strategy

- **Domain (Vitest):** reference-value tables for the fee, minimum price and markup conversions, validation order and error codes, overflow boundaries, a 1,000-order randomized sweep checking the sum identities and margin `>= 0`, and money parsing (no floating-point multiplication).
- **API (Vitest + Supertest, real Postgres):** black-box HTTP contract tests written only from the DTOs and the endpoint list, plus implementation-side tests for pay rollback after the ledger insert, idempotent double pay, concurrent pay and cancel pairs, ownership and persona rules, and search and pagination. Each checkout uses its own test database, truncated and reseeded with stable ids per test.
- **Web (Vitest + Vue Testing Library + jsdom):** behavior tests for the builder (linked Markup % and price, minimum-price state, lenient drafts), pay, login and lists; loading, error, empty and forbidden-persona states for every data-loading view; and axe-core scans of each screen and key state, including PrimeVue's teleported dialog. Testing Library conventions are enforced by lint.
- **End to end (Playwright, Chromium):** three specs against the real API and Vite on a dedicated `supplement_orders_e2e` database reset before each run. The happy path checks the processing fee shown, the cost + fee = minimum identity, the ledger total, and that the dashboard GMV, margin and fees rise by exactly the order's amounts while stock drops by exactly the quantity. The other two cover a simulated gateway failure and cancelling.
- **Cross-model test authoring:** most suites were written first by a different model (Grok) from the one implementing (Claude), against written contracts. See [AI_USAGE.md](AI_USAGE.md).

## 12. Deployment plan (not yet deployed)

The application has **not been deployed**. The proposed shape:

- A single Node service that serves both the API and the built SPA from `apps/web/dist`, so there's one origin and no CORS. That requires a small addition: the API doesn't serve static files yet.
- Managed Postgres such as Neon, which supports the `pg_trgm` extension that migration `0005` creates.
- Run `db:migrate` on deploy. Set `NODE_ENV=production`, which disables `simulateFailure`.
- The API currently runs under `tsx`. A compiled build (tsc or esbuild) would trim startup time but isn't required.

## 13. Production hardening and future work

- **Refunds** as new negative or reversing ledger entries, never edits to existing ones. Cancelling a paid order is out of scope today.
- **Provider payouts:** the ledger says what each provider is owed; actually moving money is a separate system.
- **Payment reconciliation:** the charge happens inside the database transaction. A real gateway needs a job that reconciles charges whose transaction never committed, or an outbox and webhook flow so the charge and the commit can't diverge. If the real gateway caches declines per idempotency key, retries need a per-attempt key.
- **Real auth and RBAC:** replace `HeaderAuth` with real authentication behind the same interface. Date of birth and address are PHI, so access to them needs HIPAA-grade access controls and audit logging.
- **Database-level ledger guarantees:** a trigger or deferred constraint that rejects updates and deletes on `ledger_entries` and checks that each payment's entries sum to its amount.
- **Rate limiting** on the API, especially pay and search.
- **Observability:** structured logs with order and payment ids, metrics on pay latency and gateway declines, and alerting on any `LedgerImbalanceError` or post-charge rollback.
- **Search at larger scale:** the old `lower(name)` btree indexes are now unused and could be dropped.
