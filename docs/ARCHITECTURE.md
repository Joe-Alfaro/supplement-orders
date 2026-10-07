# Architecture

This describes the system as it stands now. The reasoning behind each choice, including the ones that were reversed along the way, is in [DECISIONS.md](DECISIONS.md).

## 1. Goals and non-goals

**Goals**

- A provider assembles an order for a patient and sets the patient-facing price per item.
- The patient pays through a stubbed payment step.
- Every paid order is split into wholesale cost (COGS), provider margin and a 75 bps platform fee. The three parts sum exactly to the amount paid.
- A paid order is auditable from stored data alone: every cent is attributed to one of those three buckets in an append-only ledger.
- Providers can find any of their orders by status, and a dashboard shows sales totals and current stock. Stock is never edited by hand: a payment attempt reserves it before charging, a decline gives it back, and a recorded payment keeps it as the sale.
- GMV and platform fee revenue are directly queryable.

**Non-goals** (from the brief)

- Real payments, auth, email, shipping or fulfillment.
- Tax, shipping cost, regulatory compliance, multi-state or international handling.
- Warehouse or multi-location inventory.
- Refunds. Only orders awaiting payment can be cancelled; paid orders have no actions.

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
| Tests          | Vitest 4, Supertest, Vue Testing Library, user-event, jest-dom, axe-core, Playwright              |
| Tooling        | npm workspaces, ESLint (encodes the code style rules), Prettier                                   |
| Hosting        | Railway: one Node 22 service built with Railpack, plus Railway Postgres                           |

The domain package is consumed as TypeScript source with no build step. The API runs under `tsx` in development and has no compile step yet. npm 10.9 crashes while resolving Vitest 4, so the lockfile was generated with npm 11. `npm ci` and `npm install` from the lockfile work on npm 10; changing the Vitest version needs npm 11 to regenerate it.

## 4. Domain model

| Entity           | Key fields                                                                                                                            | Notes                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `User`           | `name`, `role` (`provider` or `patient`)                                                                                              | A user has exactly one role, stored on the record. The client never asserts a role                                                                                                                                                         |
| `Provider`       | `userId` (unique)                                                                                                                     | One-to-one profile for a provider user. Receives margin                                                                                                                                                                                    |
| `Patient`        | `userId` (unique), `providerId`, `dateOfBirth`, `address`                                                                             | Belongs to one provider. Name plus date of birth is how a provider tells patients apart                                                                                                                                                    |
| `Product`        | `sku` (unique), `name`, `cogsCents` (wholesale cost), `stockQuantity`                                                                 | Available stock. A payment attempt reserves the order's quantities before charging; a decline releases them; a recorded payment keeps them as the sale                                                                                     |
| `Order`          | `providerId`, `patientId`, `status`, `revision`, `subtotalCents`, `platformFeeCents`, `totalCents`, `sentAt`, `paidAt`, `cancelledAt` | Totals are snapshotted when the order is sent. `revision` is 0 for a new draft and goes up by one on every send, so each send is a new quote                                                                                               |
| `OrderItem`      | `productId`, `quantity`, `unitPriceCents`, `unitCogsCents`                                                                            | Draft lines may lack a product or a price. Cost is snapshotted on the line, so later catalog changes never alter a sent or paid order                                                                                                      |
| `PaymentAttempt` | `orderId`, `revision`, `execution`, `idempotencyKey` (unique), `amountCents`, `status`, `gatewayReference`, `stockHeld`               | One row per try at charging a quote. The key is `order-<id>-r<revision>-e<execution>`. `status` is `pending` (stock reserved, outcome unknown), `succeeded`, `declined` or `conflict`. `stockHeld` says whether it holds the order's stock |
| `Payment`        | `orderId` (unique), `amountCents`, `idempotencyKey` (unique), `gatewayReference`, `paymentAttemptId` (unique)                         | At most one per order. Points at the succeeded attempt it finalizes (null only for payments recorded before attempts existed)                                                                                                              |
| `LedgerEntry`    | `orderId`, `paymentId`, `type` (`cogs`, `provider_margin`, `platform_fee`), `amountCents`                                             | Exactly three per payment, unique on `(paymentId, type)`. Append-only                                                                                                                                                                      |

Order status lifecycle:

```
            ┌──────────────────── reopen ───────────────────┐
            v                                               │
 (new) ──> draft ──send──> pending_payment ──pay──> paid     │
            │                    │                          │
          delete               cancel ──> cancelled ────────┘
            v
        (row removed)
```

- **Delete** removes a draft and its lines for good. A draft has no `sentAt`, so it has no payment, no ledger rows, and the patient can't see it. That's why a hard delete is safe. A draft created by reopen was sent earlier, but reopen already cleared that history.
- **Cancel** applies only to `pending_payment`. Drafts are deleted instead, and paid orders can't be cancelled.
- **Reopen** moves `cancelled` back to `draft`. It clears `sentAt`, `cancelledAt` and the stored totals, keeps the lines, and hides the order from the patient until it's sent again.

Every state change (edit, send, delete, cancel, reopen) runs in a transaction that first locks the order row with `SELECT ... FOR UPDATE`, so any two of them on the same order serialize: the second waits on the row lock. If the first left a status the second action doesn't allow, the second gets a 409, or a 404 if the row was deleted. Two edits of an order that is still a draft both succeed, and the later one wins. Pay is the exception: it's several short transactions, each taking the same lock, with the gateway call in between and outside any lock (§6). An unresolved payment attempt is what keeps the other actions out while the charge is in flight. A second pay of an order the first pay already completed returns the existing result, not a 409. None of the actions except pay touches stock or the ledger.

Why a ledger rather than three columns on the order: "where did every cent go" becomes a query over append-only rows, GMV and fee revenue are a `SUM` grouped by entry type, and future adjustments (refunds, corrections) can be new entries instead of mutations.

Database constraints back the model:

- Every money column is `bigint` cents. `products.cogs_cents`, `order_items.unit_price_cents`, `order_items.unit_cogs_cents`, `payment_attempts.amount_cents`, `payments.amount_cents` and `ledger_entries.amount_cents` have a `>= 0` check. The three order totals (`subtotal_cents`, `platform_fee_cents`, `total_cents`) don't; their non-negativity is an application invariant.
- `orders_total_is_subtotal`: the patient total equals the subtotal. This constraint was added `NOT VALID` so rows from before that rule are left alone; every new or updated row is checked.
- `orders_fee_within_subtotal`, `orders_paid_at_iff_paid`, `orders_cancelled_at_iff_cancelled`, `orders_sent_unless_draft_or_cancelled`, `orders_totals_present_once_sent`, and `orders_revision_counts_sends` (a sent order has a revision of at least 1). (`cancelled` without `sentAt` is still allowed because revision 6 let drafts be cancelled; new cancels always have `sentAt`.)
- `order_items`: quantity `>= 1`, one line per product per order, and a cost snapshot exactly when a product is set.
- Unique `payments.order_id`, unique `payments.idempotency_key`, unique `payments.payment_attempt_id`, unique `ledger_entries(payment_id, type)`.
- `payment_attempts`: unique `idempotency_key`, unique `(order_id, revision, execution)`, `execution >= 1`, and a gateway reference exactly when the status is `succeeded`. Nothing in the database checks that a payment matches its attempt's order, amount or reference; the application does.

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
2. **Edit lines.** `PUT /api/orders/:id/lines` replaces all lines. Drafts are lenient: a line may omit the product or the price, and a price may be below the minimum. Save returns 400 for a non-integer, a quantity outside 1–1000, or a price outside 0–1,000,000 cents ($10,000 per unit), and 422 for a duplicate or unknown product. Completeness, stock and the minimum are enforced on send. The builder shows a live split computed with the shared `computeSplit` once all lines are complete.
3. **Send.** `POST /api/orders/:id/send`, in one transaction:
   - lock the order row (`SELECT ... FOR UPDATE`) and require it to be the caller's draft;
   - require at least one line (`EMPTY_ORDER`), every line complete (`INCOMPLETE_LINE`), enough stock (`INSUFFICIENT_STOCK`), and every price at or above its minimum (`PRICE_BELOW_MINIMUM`, from `computeSplit`);
   - re-snapshot each line's wholesale cost from the product, and store the subtotal, fee and total on the order;
   - set the status to `pending_payment`, record `sentAt`, and add one to `revision`.

   After commit, the notifier is called. A notification failure is logged and doesn't undo the send.

4. **Pay.** `POST /api/orders/:id/pay` by the patient, with the body `{ expectedRevision, expectedTotalCents, simulateFailure? }`: the revision and total the patient's screen showed. Pay runs as several short transactions, and the gateway is called between them, outside any lock:
   1. **Prepare** (one transaction, order row locked `FOR UPDATE`). If the order was never sent, respond 404; if it's already `paid`, return the existing result without charging again, provided the request names the paid revision and total; if it's otherwise not `pending_payment`, respond 409 `ORDER_NOT_PAYABLE`. If the order's current `revision` or `totalCents` differs from what the request names, respond 409 `ORDER_CHANGED` and charge nothing. An unresolved attempt left over from an earlier revision is a 409 `PAYMENT_NEEDS_RECONCILIATION`. Then pick the attempt to charge: an unresolved attempt for this revision (`pending`, `succeeded` without a payment, or `conflict`) is reused with its existing key. Only when there's no attempt yet, or the latest was `declined`, does a new execution start: stock for every line is decremented with a conditional update (`stock >= quantity`, ascending product id so two orders can't deadlock), and a `pending` attempt with key `order-<id>-r<revision>-e<execution>` and `stockHeld` is inserted. A short stock is a 422 `INSUFFICIENT_STOCK` here, before any charge. This transaction commits before the gateway is called.
   2. **Charge** the `PaymentGateway` with the attempt's key and amount. An attempt that already `succeeded` isn't charged again: its outcome is checked with the gateway's `lookup`, which never charges, and must show a success for the same amount and reference.
   3. **Apply the outcome** (one transaction, order locked), fenced: the attempt is updated only if it's still the same execution and still `pending` or `conflict`, so a stale or duplicate response changes nothing. A success stores the gateway reference. A decline marks the attempt `declined`, releases its stock in the same transaction (only if the fenced update matched) and returns 402 `PAYMENT_FAILED`. An `IDEMPOTENCY_KEY_REUSED` refusal, or a success for a different amount, isn't a decline: the attempt becomes `conflict`, keeps its stock, and pay returns 409 `PAYMENT_NEEDS_RECONCILIATION`.
   4. **Finalize** (one transaction, order locked): check that the order is still `pending_payment` at the attempt's revision and total, recompute the split from the snapshotted lines with `computeSplit` and abort if it doesn't reproduce the stored total, insert the `Payment` pointing at the attempt (its held stock becomes the sale), build the three ledger entries, assert they sum to the payment amount, insert them, and mark the order `paid` with `paidAt`.

   If finalizing fails, it rolls back alone: the attempt stays `succeeded` with no payment and keeps its stock, and the request fails with a 500. A retried pay with the same revision and total verifies that success by lookup and finalizes it, with no second charge. Concurrent pays of one attempt send the same key, and the gateway gives them the identical outcome. The unique constraints on `payments.order_id`, `payments.payment_attempt_id` and `ledger_entries(payment_id, type)` back this at the database level.

   **Blocking.** While any attempt for the order is `pending`, `succeeded` without a payment, or `conflict`, cancel, reopen, delete and line edits return 409 `PAYMENT_NEEDS_RECONCILIATION`, ahead of any status error. A `declined` latest attempt or a recorded payment unblocks the order.

   **Recovery after a restart.** Attempts and the fake gateway's charges are both in the database, so nothing depends on process memory. A `pending` attempt left by a crash is resolved by the next pay: charging its key again replays the stored outcome if the gateway saw the first call, or makes the one charge if it never did. A `succeeded` attempt without a payment is finalized after a lookup, as above. Nothing resolves an attempt on its own: there's no background job, so an attempt stays blocked, holding its stock, until the patient pays again. A `conflict` attempt can't be resolved in the app at all and needs manual reconciliation (see §14).

5. **Cancel.** `POST /api/orders/:id/cancel` by the provider, for `pending_payment` orders only. It takes the same row lock as pay's transactions, so a cancel and a pay can't both succeed: a cancel that commits first makes the pay a 409 `ORDER_NOT_PAYABLE`, and once pay has committed an attempt, cancel gets 409 `PAYMENT_NEEDS_RECONCILIATION` until the attempt is declined, or `ORDER_NOT_CANCELLABLE` once the order is paid. Cancelling writes no ledger entries and doesn't touch stock; a declined attempt has already given its stock back. The patient is notified and sees the order as cancelled, with no Pay button.
6. **Delete a draft.** `DELETE /api/orders/:id` locks the order, requires the caller's draft (409 `ORDER_NOT_DRAFT` otherwise), deletes its lines, any declined attempts left from before a reopen, and the order, and returns 204. If a send wins the lock first, the delete gets the 409; if the delete wins, the send gets a 404.
7. **Reopen.** `POST /api/orders/:id/reopen` locks the order, requires it to be `cancelled` (409 `ORDER_NOT_REOPENABLE` otherwise), and returns it to `draft` as described in §4. Stock is untouched, since only pay attempts move stock. The revision is kept, so the next send is a new quote.
8. **Read.** The provider's order detail shows the snapshotted lines, the split, the payment reference and the three ledger entries with a "Total of entries" check. The patient's view has its own DTO type with no cost, margin, fee or ledger fields, so those can't leak by accident.

## 7. Seams

All three are interfaces in `apps/api/src/seams/`, passed to `createApp(deps)`. Tests inject their own (for example a `RecordingNotifier`, or test-only hooks inside the pay transaction to prove rollback after the ledger insert).

| Seam             | Interface                                                                                                                                                                                                                      | Fake                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentGateway` | `charge({ amountCents, idempotencyKey, description, simulateFailure? }, { simulateFailure? }) -> { status, reference, amountCents?, failureMessage? }`; `lookup(idempotencyKey) -> { status, amountCents, reference } \| null` | `FakePaymentGateway`: a stand-in for a processor with durable idempotency. Its state is the `fake_gateway_charges` table (key, amount, `succeeded` or `declined`, a unique `fake_ch_<uuid>` reference), written in its own committed statements, never inside the API's transactions. The first call for a key decides the outcome atomically (insert, or read the existing row); later calls with the same key and amount replay it, decline included; the same key with another amount fails with `IDEMPOTENCY_KEY_REUSED` and charges nothing. `lookup` never charges. It survives restarts and is shared by every API process on the same database. The API ignores `simulateFailure` when `NODE_ENV` is `production` |
| `Auth`           | `getCurrentUser(req) -> { userId, role, providerId, patientId? }`                                                                                                                                                              | `HeaderAuth`: reads `X-User-Id`, loads the user and their provider or patient profile, and takes the role from the database. Missing, malformed or unknown id is 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Notifier`       | `notifyPatientOrderReady(orderId)`, `notifyPatientOrderCancelled(orderId)`                                                                                                                                                     | `ConsoleNotifier` logs to the console                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Shipping isn't modeled; the patient's address is a plain string.

## 8. Metrics

- **GMV** is the sum of `payments.amount_cents` for the provider's paid orders: what patients actually paid.
- **Margin earned** and **processing fees** are sums of the `provider_margin` and `platform_fee` ledger entries.

The dashboard tiles read the audited rows rather than recomputing anything, all three in one SQL statement so they describe one snapshot, and an aggregate beyond `Number.MAX_SAFE_INTEGER` is a 500 rather than a rounded number. Cancelled and unpaid orders contribute nothing because they have no payment or ledger rows. GMV counts finalized payments: a charge that succeeded at the gateway but hasn't been finalized yet is missing until a retried pay records it. There's no date filter in the UI; the queries are a `WHERE` clause away from one. Platform-wide fee revenue is a `SUM` over `platform_fee` entries, but it isn't exposed anywhere because there's no admin persona.

## 9. API

Every endpoint except `/api/health` and `/api/users` requires `X-User-Id`. Application errors use `{ error: { code, message, field? } }`, where `field` is a dotted path into the request body (for example `lines.1.unitPriceCents`) so the UI can place the message next to the input. Money fields are integer cents with a `Cents` suffix. Health is the exception to the error envelope: it returns `{ status, db }`, with 503 when Postgres is unreachable.

| Method and path                                     | Who      | Purpose                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                   | anyone   | 200 if Postgres is reachable, 503 otherwise                                                                                                                                                                                                                                                                 |
| `GET /api/users`                                    | anyone   | Seeded users for the login screen                                                                                                                                                                                                                                                                           |
| `GET /api/products?q=&offset=&limit=`               | provider | Paginated catalog search by name or SKU                                                                                                                                                                                                                                                                     |
| `GET /api/patients?q=&latestStatus=&offset=&limit=` | provider | The provider's patients. Name substring, or exact date of birth when `q` is `MM/DD/YYYY` or `YYYY-MM-DD`. `latestStatus` is `none`, `draft`, `pending_payment`, `paid` or `cancelled`                                                                                                                       |
| `GET /api/patients/:id`                             | provider | Patient detail                                                                                                                                                                                                                                                                                              |
| `GET /api/orders?patientId=`                        | both     | Without `status`: orders visible to the caller, as an array. Patients never see unsent orders                                                                                                                                                                                                               |
| `GET /api/orders?status=&patientId=&offset=&limit=` | provider | A page of the provider's orders. `status` is `all` or a comma list of `draft`, `pending_payment`, `paid`, `cancelled`; duplicates are ignored and an unknown value is a 400 on `status`. Exactly `pending_payment` sorts oldest sent first; anything else sorts by most recent activity. A patient gets 403 |
| `POST /api/orders`                                  | provider | Create a draft (201)                                                                                                                                                                                                                                                                                        |
| `GET /api/orders/:id`                               | both     | Provider view (lines, split, payment, ledger) or patient view (lines and total)                                                                                                                                                                                                                             |
| `PUT /api/orders/:id/lines`                         | provider | Replace a draft's lines                                                                                                                                                                                                                                                                                     |
| `POST /api/orders/:id/send`                         | provider | Draft to `pending_payment`                                                                                                                                                                                                                                                                                  |
| `POST /api/orders/:id/pay`                          | patient  | Pay the quote shown. Body `{ "expectedRevision", "expectedTotalCents" }`, plus `"simulateFailure": true` outside production                                                                                                                                                                                 |
| `POST /api/orders/:id/cancel`                       | provider | Cancel an order awaiting payment                                                                                                                                                                                                                                                                            |
| `POST /api/orders/:id/reopen`                       | provider | Return a cancelled order to draft                                                                                                                                                                                                                                                                           |
| `DELETE /api/orders/:id`                            | provider | Permanently delete a draft (204)                                                                                                                                                                                                                                                                            |
| `GET /api/dashboard`                                | provider | GMV, margin and fees                                                                                                                                                                                                                                                                                        |

Status codes: 400 `VALIDATION_ERROR`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` (wrong persona or someone else's resource), 404 `NOT_FOUND`, 409 wrong order status (`ORDER_NOT_DRAFT`, `ORDER_NOT_PAYABLE`, `ORDER_NOT_CANCELLABLE`, `ORDER_NOT_REOPENABLE`), 409 `ORDER_CHANGED` (pay named a revision or total that's no longer current), 409 `PAYMENT_NEEDS_RECONCILIATION` (an unresolved payment attempt blocks the action), 422 business rules (`EMPTY_ORDER`, `INCOMPLETE_LINE`, `PRICE_BELOW_MINIMUM`, `INSUFFICIENT_STOCK`, `DUPLICATE_PRODUCT`, `UNKNOWN_PRODUCT`, and the other split codes), 402 `PAYMENT_FAILED`, and 500 `INTERNAL` for an unexpected failure, including a sent order whose lines no longer reproduce the stored total.

409 messages are written for people and use the same status names as the UI, from `ORDER_STATUS_LABELS` in the domain package (Draft, Awaiting payment, Paid, Cancelled). For example: "This order is paid; only orders awaiting payment can be cancelled." The UI shows them in its error banner and re-fetches the order.

Request and response types are TypeScript interfaces in `packages/domain/src/api/`, each paired with a Zod schema typed against the interface so the two can't drift. The web app imports the same types.

## 10. Search and pagination

- Products and patients use offset pagination returning `{ items, total, offset, limit }`. The default limit is 25 and the maximum 100. Ordering is by name, then id, so pages are stable.
- Search is a case-insensitive substring match (`ILIKE '%q%'`) with `%`, `_` and `\` escaped, so they match literally. Products match name or SKU. Patients match name, plus an exact date of birth when the whole query is a valid date. Address is deliberately not searched.
- A btree index can't serve a substring match, so migration `0005` enables `pg_trgm` and adds GIN trigram indexes on `products.name`, `products.sku` and `users.name`. The queries `ILIKE` the bare columns, which is what those indexes match.
- `npm run explain:search -w apps/api` loads 50,000 products and 20,000 patients into a throwaway database and prints the query plans before and after the trigram indexes. In one local run, a selective product name search went from about 38 ms (sequential scan) to about 0.2 ms (bitmap index scan on the trigram index), and the matching count query from about 40 ms to about 0.1 ms. A common term such as "ashwagandha" doesn't benefit on the first page, because a page of 25 is found quickly by walking the name index. Its count query still dropped from about 44 ms to about 5 ms. Timings vary by machine.
- The provider order list has its own indexes. Migration `0004` adds `(provider_id, status, sent_at, id)` for the oldest-sent-first awaiting-payment view. Migration `0006` adds two indexes on `(provider_id, [status,] coalesce(paid_at, cancelled_at, sent_at, created_at) desc, id desc)`, matching the "most recent activity" sort, plus `(patient_id, created_at desc, id desc)` for a patient's orders.

Migrations, all in `apps/api/drizzle/`:

| Migration | What it does                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000`    | Initial schema                                                                                                                                             |
| `0001`    | Revision 2: nullable draft line fields, `total = subtotal`, fee within subtotal                                                                            |
| `0002`    | Name and ordering indexes for paginated lists                                                                                                              |
| `0003`    | Patient date of birth                                                                                                                                      |
| `0004`    | `cancelled_at`, status/timestamp checks, the awaiting-payment index                                                                                        |
| `0005`    | `pg_trgm` and trigram GIN indexes                                                                                                                          |
| `0006`    | Order list activity indexes                                                                                                                                |
| `0007`    | Revision 9: `orders.revision`, the `payment_attempts` table, `payments.payment_attempt_id`                                                                 |
| `0008`    | Revision 9: `payment_attempts.stock_held`, for stock reserved by an attempt                                                                                |
| `0009`    | Revision 10: `fake_gateway_charges`, attempt executions and the `declined`/`conflict` statuses; seeds the fake gateway with the successes already recorded |

## 11. Front end

- Vue 3 single-page app with Vue Router (history mode) and PrimeVue 4 (Aura preset, light only). Lazy `DataTable`s map directly onto the API's `{ items, total, offset, limit }` pages. Money and percent inputs are plain text inputs parsed by the shared integer parser, never PrimeVue's float-based `InputNumber`.
- Provider navigation is **Patients | Orders | Dashboard**; a patient sees **My Orders**. The routes guard on the role from the server's user record and redirect the other persona with a notice. That's a convenience, not security; the API enforces access.
- **Orders tab:** a paginated table of the provider's orders with a multi-select Status filter (Draft, Awaiting payment, Paid, Cancelled, plus a select-all box). The default is all statuses. An empty selection also means all statuses, shown with the placeholder "All statuses".
- **Order detail actions** depend on status: Delete draft, Cancel order (awaiting payment) and Reopen as draft (cancelled), each behind a confirmation dialog. Reopen takes the provider straight to the builder.
- **Dashboard:** three tiles (GMV, Your margin earned, Processing fees), links "See paid orders →" (`/orders?status=paid`) and "See orders awaiting payment →" (`/orders?status=pending_payment`), and a searchable, read-only inventory table.
- **URL state:** every list's filters, search and page live in query parameters: Orders `status` and `page`, Patients `q`, `status` and `page`, and the inventory's `q` and `page`. Defaults are left out of the URL. Changing a filter resets the page. Typing in a search box updates the URL with `router.replace` (debounced), so it doesn't flood history; filter and page changes use `router.push`, so Back steps through them. A shared `useListUrl` helper, used by Orders, Patients and the Dashboard, guards these writes: navigating to another path (or unmounting) cancels any pending debounced search, `replace` writes happen only while the view's route is still current and no navigation is in flight, and `push` writes only while the router is still on the view. Without that guard, a debounced `router.replace` could land after a link click had started navigating (while the lazy target view loaded) and abort it.
- **Layout:** page content sits in a centered column with a 1200px max width. The header bar is full width with its contents aligned to that column.
- Views fetch through one typed function per endpoint in `apps/web/src/api/`, with no client cache. State is composables and `ref`/`computed`; there's no store library.

## 12. Testing strategy

- **Domain (Vitest):** reference-value tables for the fee, minimum price and markup conversions, validation order and error codes, overflow boundaries, a 1,000-order randomized sweep checking the sum identities and margin `>= 0`, and money parsing (no floating-point multiplication).
- **API (Vitest + Supertest, real Postgres):** black-box HTTP contract tests written only from the DTOs and the endpoint list, plus implementation-side tests for pay rollback after the ledger insert, idempotent double pay, stale quotes, concurrent pay and cancel pairs, payment execution safety (held and overlapping gateway responses, fenced outcomes, a key conflict that keeps its reservation, last-unit competition, and restarts simulated with a freshly constructed gateway and app on the same database, checking that the gateway's successful references equal the recorded payments), delete and reopen, the order list filters and sort orders, ownership and persona rules, search and pagination, and production SPA serving. Each checkout uses its own test database, truncated and reseeded with stable ids per test.
- **Web (Vitest + Vue Testing Library + jsdom):** behavior tests for the builder (linked Markup % and price, minimum-price state, lenient drafts), pay, login and lists; loading, error, empty and forbidden-persona states for every data-loading view; and axe-core scans of each screen and key state, including PrimeVue's teleported dialog. Testing Library conventions are enforced by lint.
- **End to end (Playwright, Chromium):** six spec files (9 tests) against the real API and Vite on a dedicated `supplement_orders_e2e` database, reset once before each run. The happy path checks the processing fee shown, the cost + fee = minimum identity, the ledger total, and that the dashboard GMV, margin and fees rise by exactly the order's amounts while stock drops by exactly the quantity. The others cover a simulated gateway failure, cancelling, the order lifecycle (delete a draft, send, cancel, reopen, pay, and the Orders and Patients status filters), a stale patient page that gets "order changed" and pays the new total after reloading, and URL-state navigation: four cases that type into a debounced search and then click a link while the next view's code is still loading, which reproduces the bug described in §11.
- **Cross-model test authoring:** most suites were written first by a different model (Grok) from the one implementing (Claude), against written contracts. Codex finished the revision 10 payment tests. See [AI_USAGE.md](AI_USAGE.md).

## 13. Deployment

The app is deployed at <https://web-production-b7c8c.up.railway.app>. That deployment predates revisions 9 and 10: it runs the older payment flow (no quote check, the charge inside one database transaction) and still returns the removed `paidOrders` list from the dashboard API. The README's [Deployment](../README.md#deployment) section has the exact commands and variables.

- **Railway project** `supplement-orders` with two services: `web` (the app) and `Postgres`. `DATABASE_URL` on `web` references the Postgres service's private URL.
- **Build:** Railpack with Node 22 (`engines` is `>=22.13 <23`), running `npm run build`. Railpack's install step already includes dev dependencies such as Vite.
- **Pre-deploy:** `npm run db:migrate && npm run db:seed:if-empty`. The seed step loads the full demo seed (the named users plus 300 products and 250 patients) only when the database has no users, and never deletes anything.
- **Run:** `npm start` runs the API under `tsx`. With `NODE_ENV=production` the same process serves the built SPA from `apps/web/dist`: fingerprinted `/assets/` files are cached for a year, a missing `/assets/` file is a plain 404 rather than `index.html`, `index.html` is `no-cache`, and any other non-API GET falls back to `index.html`, so a route such as `/orders?status=paid` works. Unknown `/api` paths still return a JSON 404. One origin, no CORS. The process refuses to start if the web build is missing.
- **Health check:** `GET /api/health`, with restart on failure.
- `NODE_ENV=production` also disables `simulateFailure`, so the decline path can only be demonstrated locally.
- **Config:** `railway.json` records the build and deploy settings, but Railway has [deprecated Config as Code](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code) and new services don't read it. The same settings were applied to the service directly. If the service is ever recreated, they have to be applied again.
- **Deploys** run `railway up` from an up-to-date `main`. Railway's repo auto-deploy supports only GitHub, and this repository is on GitLab.
- **Accepted risk:** auth is stubbed on the public URL too, so anyone can act as any seeded user. All data is fake.

## 14. Production hardening and future work

- **Refunds** as new negative or reversing ledger entries, never edits to existing ones. Cancelling a paid order is out of scope today.
- **Provider payouts:** the ledger says what each provider is owed; actually moving money is a separate system.
- **Payment reconciliation:** an unresolved attempt is only resolved when the patient pays again, and a `conflict` not even then. A real integration needs a reconciliation job or support tool that looks up unresolved attempts with the processor and finalizes or releases them, plus the processor's webhooks. Releasing stock on a timeout alone would be wrong while the outcome is unknown. The fake gateway shares the app's database for convenience; a real processor's store is its own.
- **Real auth and RBAC:** replace `HeaderAuth` with real authentication behind the same interface. Date of birth and address are PHI, so access to them needs HIPAA-grade access controls and audit logging.
- **Database-level ledger guarantees:** a trigger or deferred constraint that rejects updates and deletes on `ledger_entries` and checks that each payment's entries sum to its amount.
- **Rate limiting** on the API, especially pay and search.
- **Observability:** structured logs with order and payment ids, metrics on pay latency and gateway declines, and alerting on any `LedgerImbalanceError` or post-charge rollback.
- **Cleanup:** the old `lower(name)` btree indexes are unused and could be dropped.
- **Deploys from CI** rather than `railway up` from a laptop, which needs either a GitHub mirror or a CI job with a Railway token.
