# Decisions and tradeoffs

The key calls, in roughly the order they shaped the system. Each lists what was decided, why, what else was considered, and what it cost. Reversed decisions are kept, with the reason they changed, because several of them taught us something.

## Money and data

**Integer cents everywhere**

- **Decision:** every amount is an integer number of cents, stored as `bigint`. Dollar strings exist only at input and display. Parsing uses a regex to capture the dollar digits and up to two decimal digits, strips commas, and concatenates them into a cent integer. No float multiplication.
- **Why:** floats can't represent cents exactly, and the split has to reconcile to the cent.
- **Alternative:** a decimal library.
- **Tradeoff:** unsafe-integer checks are needed at the edges. The split, fee, minimum-price and markup functions reject an unsafe integer as `UNSAFE_AMOUNT`. Formatting throws a `RangeError`, and parsing returns a field error string instead.

**A three-entry ledger, not three columns on the order**

- **Decision:** each payment writes `cogs`, `provider_margin` and `platform_fee` entries. Their sum is asserted to equal the payment amount before insert, and the database has a unique `(payment_id, type)`.
- **Why:** auditability is a requirement. A ledger makes "where did every cent go" a query, makes GMV and fees a `SUM`, and leaves room for refunds as new entries.
- **Alternative:** split columns on `orders`.
- **Tradeoff:** a little more schema. Immutability is enforced by the application, not by a trigger.

**The fee is computed once, on the order subtotal**

- **Decision:** 75 bps of the subtotal, never per line.
- **Why:** per-line rounding accumulates error.
- **Tradeoff:** the per-line fee shown in the order builder is informational. Because each line rounds up on its own, the per-line fees can sum to more than the order fee by more than a cent (three 1-cent lines: 3 cents versus 1). The order fee is never larger than that sum. The summary labels its fee "calculated on the order total".

**Reversed: fee charged on top -> fee comes out of the provider's markup**

- **First decision:** the patient paid subtotal + fee, so the provider's margin was untouched.
- **Final decision:** the patient pays exactly the subtotal the provider priced. The provider receives subtotal - wholesale cost - fee.
- **Why it changed:** the product owner clarified the business model. We're the platform, providers mark up wholesale cost, and the 75 bps comes out of that markup. It isn't a patient surcharge.
- **Tradeoff:** the provider bears the fee, so a price floor became necessary (next item). Both test suites had to be rewritten.

**Minimum unit price, enforced on send**

- **Decision:** each unit price must be at least `cost + ceil(75 * cost / 9925)`, the smallest price whose markup covers 75 bps of itself rounded up.
- **Why:** it makes a negative provider margin impossible. The obvious rule, "price >= cost + fee rounded half up", has a hole: two lines with cost $0.66 priced at $0.66 give a $0.01 order fee on $1.32 and a margin of -$0.01. We found that counterexample before writing the rule down, and brute-checked the final rule over 200,000 random orders.
- **Alternatives:** price >= cost (allows negative margin once the fee comes out); a fixed catalog price (removes provider pricing).

**Reversed: fee rounded half up -> fee rounded up**

- **First decision:** the fee was 75 bps rounded half up, the conventional choice, while the minimum price rounded the per-unit fee up.
- **Final decision:** the fee rounds up everywhere: `floor((subtotal * 75 + 9999) / 10000)`.
- **Why it changed:** the product owner found a product with a $5.81 cost, a $5.86 minimum price, and a displayed fee of $0.04. Those three numbers don't add up on screen. The exact fee at $5.86 is 4.395 cents: the minimum assumed 5 cents but the display showed 4. With rounding up everywhere, cost + displayed fee equals the minimum price for every cost from $0 to $2,000.
- **Alternatives:** round the minimum half up (reopens the -1 cent hole); show a rounded-up fee but charge half up (the screen would show a fee that isn't charged).
- **Tradeoff:** the platform collects at most 1 cent more per order. Already-paid orders keep their stored fee, because the ledger is immutable.

**Reversed twice: gross margin % -> net margin % -> markup %**

- **First decision:** a "Margin %" field linked to the price, gross: `(price - cost) / price`.
- **Second:** net of the fee, `(price - cost - 0.0075 * price) / price`, because gross overstated what the provider keeps once the fee comes out of their markup. This was specified but cancelled before it was implemented.
- **Final decision:** **Markup %**, net markup on wholesale cost, `(price - cost - 0.0075 * price) / cost`, uncapped. 0% is the minimum price, and 300% on a $10.00 cost is $40.30.
- **Why it changed:** the product owner asked why the margin had a ceiling. Margin over price can never reach 100%, so "300%" was impossible to enter. Practitioners talk about marking up wholesale ("50% over wholesale", "2x wholesale"), and the product owner chose markup.
- **Tradeoff:** markup is undefined at zero cost (the UI shows a dash and takes the price only). Round trips between percent and price are not exact, because price rounds to whole cents. The field being edited is never overwritten.

**Reversed: drafts validated on every save -> lenient drafts, strict send**

- **First decision:** every draft save ran the full split validation, so a stored draft was always priceable.
- **Final decision:** drafts may be saved with no product, no price, or a price below the minimum. Send enforces completeness, stock, and the minimum.
- **Why it changed:** product owner feedback. Providers build orders incrementally, and refusing to save half-finished work is hostile. An earlier test dispute had been settled in favor of strict saves; this reversed it.
- **Tradeoff:** a draft can sit in an unsendable state. The API returns `split: null` for such a draft, so the UI never shows a split the server would refuse to charge.

**Snapshot cost and prices on the line**

- **Decision:** `unitCogsCents` and `unitPriceCents` live on `order_items`. Cost is re-snapshotted at send. Pay recomputes the split from the snapshot and refuses if it doesn't reproduce the stored total.
- **Why:** later catalog edits must never change what a sent or paid order says.

## Payment flow

**Stock is decremented before the charge**

- **Decision:** inside the pay transaction the order is locked `FOR UPDATE`, then stock is conditionally decremented, then the gateway is charged.
- **Why:** with the decrement after the charge, an insufficient-stock rollback would happen after the patient had been charged. Moving it first means every expected failure happens before money moves.
- **Alternative:** charge outside the transaction with an outbox. That's the right production design, but too much machinery for the slice.
- **Tradeoff:** a row lock is held across an external call, and a charge whose transaction later fails needs reconciliation. The fake replays by idempotency key; a real integration needs a reconciliation job.

**Idempotent pay**

- **Decision:** the idempotency key is `order-<id>-payment`. Paying a paid order returns the existing result, with no new charge or ledger rows. Uniqueness on `payments.order_id` and `ledger_entries(payment_id, type)` backs this up.

**Cancel shares pay's row lock**

- **Decision:** cancel takes the same `FOR UPDATE` lock as pay, so exactly one of a racing cancel and pay wins and the other gets a 409. A test runs six concurrent pairs. (Which orders can be cancelled changed in revision 8; see the next section.)
- **Tradeoff:** cancelling a paid order (a refund) is not supported.

## Order lifecycle (revision 8)

**Reversed: cancel drafts -> delete drafts, cancel only orders awaiting payment**

- **First decision (revision 6):** a provider could cancel a `draft` or a `pending_payment` order.
- **Final decision:** a draft is deleted outright (`DELETE /api/orders/:id`, behind a confirmation), and Cancel applies only to orders awaiting payment.
- **Why it changed:** product owner feedback after using the app. A hard delete is safe for a draft: it was never sent, so it has no payment, ledger rows or patient-facing history, and nothing references it.
- **Alternative:** a soft delete with a `deleted_at` column, which keeps more audit history. A draft has no financial or patient-facing history worth keeping.
- **Tradeoff:** deleting can't be undone. Delete takes the order row lock, so it can't race a send: whichever commits first wins, and the other gets a 409 or 404.

**Reopen a cancelled order as a draft**

- **Decision:** `POST /api/orders/:id/reopen` moves `cancelled` back to `draft`. It clears `sentAt`, `cancelledAt` and the stored totals, keeps the lines, and takes the provider to the builder. The patient no longer sees the order until it's sent again. Stock isn't touched, because only payment moves stock.
- **Why:** product owner request. Keeping the lines means a cancelled order can be corrected and re-sent without rebuilding it.
- **Alternative:** allow reopening paid orders. That would need refunds, which are out of scope.
- **Tradeoff:** an order's history is overwritten in place: after a reopen, the earlier send and cancel times are gone. A full status history would need an events table.

**Human-readable 409 messages**

- **Decision:** wrong-status errors say what happened in the UI's own words, for example "This order is paid; only orders awaiting payment can be cancelled." The status names come from one table, `ORDER_STATUS_LABELS`, in the domain package, which the UI's status tags also use.
- **Why:** the UI shows these messages in its error banner, for example when an order changed status in another tab. Raw codes like `pending_payment` would read as jargon there.

## Identity and auth

**Role belongs to the user, not the session**

- **Decision:** a `User` has exactly one stored role. The client sends only `X-User-Id`, and the server derives the role.
- **Why:** the first design had a role toggle in the header, which let anyone pick a role. The product owner pointed out that a real user has one role. This way the auth seam has the same shape as real auth: identity in, role from the server's record.

**A stub login screen**

- **Decision:** `/login` with a user dropdown and a visible "authentication is stubbed" notice, replacing an "Acting as" dropdown in the header, so it's obvious to anyone looking at the demo that auth is fake.

**Patients are identified by name and date of birth**

- **Decision:** patient search matches the name as a substring, plus an exact date of birth in `MM/DD/YYYY` or `YYYY-MM-DD`. Address isn't searched.
- **Why:** the first design searched name or address. The product owner pointed out that clinicians identify patients by name and date of birth, which matters when a shared office login lists hundreds of patients with duplicate names.
- **Tradeoff:** date of birth is PHI. Compliance is out of scope here, but production would need access controls and audit logging.

## UI

**Reversed: native select -> searchable, paginated Add-product modal**

- **First decision:** a single `<select>` of a few seeded products, following the brief, which puts catalog browsing out of scope.
- **Final decision:** server-side search and offset pagination for products and patients, with a two-step Add-product modal (choose a product, then set quantity and price). Products already on the order, and out-of-stock products, are disabled.
- **Why it changed:** the product owner noted that catalogs and patient lists run to hundreds or thousands of rows. A select doesn't scale, and shipping the whole catalog to the browser doesn't either.
- **Tradeoff:** this deliberately goes beyond the brief's scope. `ILIKE` substring search can't use a btree index, so we added `pg_trgm` GIN indexes and a script that shows the planner using them.

**Reversed: no component library -> PrimeVue 4**

- **First decision:** minimal hand-rolled UI, since the brief doesn't grade styling.
- **Final decision:** PrimeVue 4, styled mode, Aura preset, light only.
- **Why it changed:** the product owner asked for a modern component library. The brief puts no restriction on technology, and "no component library" was our own rule. Its lazy `DataTable` maps directly onto the paginated API, and `Dialog` replaced a hand-rolled modal.
- **Alternatives:** shadcn-vue, Vuetify, Naive UI, Element Plus.
- **Tradeoff:** a larger bundle and coupling to the library's DOM. One concrete cost: the dialog renders outside the component (teleported to `document.body`), which silently hid it from our accessibility scans until we noticed (see AI_USAGE.md). Money inputs never use PrimeVue's `InputNumber`, which works in floats; they're text inputs parsed by the shared integer parser.

**Processing fee shown read-only where the price is set; price prefilled at the minimum**

- **Decision:** the builder shows a read-only "Processing fee (0.75%)" for each line, and a new line's price starts at the minimum, so it's sendable straight away.
- **Alternative:** prefill a default markup, such as 40%. That's a pricing opinion the platform shouldn't impose.

**Accessible names from visible text**

- **Decision:** inputs inside table rows are named with `aria-labelledby`, pointing at the column header plus the row's product name (for example "Qty Magnesium Glycinate 400 mg (90 caps)"), not with visually hidden labels.
- **Why:** every word of the accessible name is visible on screen (WCAG 2.5.3, label in name), without repeating a label in every row.

**Orders tab with a multi-select status filter**

- **Decision:** a top-level Orders tab lists the provider's orders, with a multi-select Status filter and a select-all box. The default is all statuses, most recent activity first. An empty selection also means all statuses, with the placeholder "All statuses". `GET /api/orders` takes a comma list of statuses.
- **Why:** before this, a provider could only find an order through its patient or the dashboard's awaiting-payment table. The product owner wanted, for example, everything except Paid: select all, then uncheck Paid. A single-select can't express that.
- **History:** the first version defaulted to Awaiting payment only. The product owner changed the default to all statuses (revision 8d).
- **Alternative:** treat an empty selection as "show nothing". That's more literal, but an empty table with no explanation is confusing.
- **Tradeoff:** a small asymmetry (no boxes checked shows everything), which the placeholder makes explicit. The Patients list's latest-order-status filter stays single-select because nobody asked for more.

**Dashboard links instead of dashboard tables**

- **Decision:** the dashboard keeps its three tiles and the inventory, and replaces its awaiting-payment and paid-orders tables with "See paid orders →" and "See orders awaiting payment →" links into the Orders tab with that filter applied.
- **Why:** once the Orders tab existed, the dashboard tables duplicated it. One list is the single source of truth.
- **Tradeoff:** the dashboard loses its at-a-glance list of pending orders; it's one click away. The dashboard API still returns the unused paid-orders list, left in place to avoid contract-test churn during integration.

**All list state in the URL**

- **Decision:** filters, search text and page for Orders, Patients and the inventory live in query parameters. Defaults are omitted, a filter change resets the page, typing updates the URL with `router.replace`, and filter and page changes use `router.push`.
- **Why:** links, reloads, bookmarks and Back/Forward restore exactly the same view, and the dashboard links are just URLs.
- **Alternative:** component state only, which is simpler but loses the view on reload. A store library, which the app doesn't otherwise need.
- **Tradeoff:** every list view has to parse and validate its query parameters.

**Centered content column**

- **Decision:** page content is centered in a column with a 1200px max width; the header bar stays full width with its contents aligned to the column. Wide tables scroll inside the column.
- **Why:** on wide windows everything hugged the left edge.

## Testing and process

**Cross-model, test-first development**

- **Decision:** written contracts first. A different model (Grok) writes failing tests from the contract, and Claude implements. The implementer may not edit tests without the orchestrator's approval; disputes go to the orchestrator. In practice that approval was given three times, for two type-only and formatting-only fixes and one stale expected value. One domain test file, `fee-guard.test.ts`, was written by the implementer.
- **Why:** when the same model writes tests and code, the tests tend to share the code's assumptions.
- **Tradeoff:** a contract document and an extra round trip per disagreement. Covered in detail in [AI_USAGE.md](AI_USAGE.md).

**Reversed: manual end-to-end checks -> Playwright**

- **First decision:** the end-to-end flow was checked by hand in a browser, to keep the suite small.
- **Final decision:** three Playwright specs (happy path, gateway failure, cancel) on a dedicated `supplement_orders_e2e` database, run with `npm run test:e2e` and kept out of `npm test`.
- **Why it changed:** the product owner asked whether there was an end-to-end test. After half a dozen revisions to pricing rules, manual checks clearly weren't catching regressions. The happy path asserts exact dashboard and stock deltas, not just "something changed".
- **Tradeoff:** a browser download and about 30 seconds per run.

**Real Postgres in API tests, one database per checkout**

- **Decision:** API tests run against a real Postgres database, truncated and reseeded per test, with test files run serially. Each checkout gets its own test database.
- **Why:** per-test transactions that roll back can't test the app's own transaction rollback or concurrent pays. Per-checkout databases fixed a flake where parallel worktrees truncated each other's data.

**Style rules as lint rules**

- **Decision:** ESLint encodes the code style rules: no `for` loops, no `any`, no `var`, `prefer-const`, no nested ternaries, plus the Testing Library rules.
- **Why:** several agents wrote code in parallel. Lint enforces the rules mechanically instead of relying on each agent remembering them.

## Deployment

**Railway, one service plus Postgres**

- **Decision:** deploy to Railway as a single Node service that serves both the API and the built SPA, plus a Railway Postgres service. Node 22 LTS, built with Railpack. Deploys run `railway up` from `main`.
- **Why:** one deployable, one origin, no CORS, matching the architecture's single-service plan. Railway Postgres supports the `pg_trgm` extension the search migration needs.
- **Alternatives:** separate static hosting for the SPA (two deploys and CORS); Neon for Postgres (also supports `pg_trgm`, but one more account and provider).
- **Tradeoff:** Railway's repo auto-deploy supports only GitHub and this repository is on GitLab, so deploys are manual. Railway has deprecated Config as Code, so `railway.json` is a record and the settings live on the service; recreating the service means applying them again.

**Simulated gateway failure off in production**

- **Decision:** `NODE_ENV=production` on the deployed service, which disables the "Simulate gateway failure (dev only)" control.
- **Why:** a public URL shouldn't expose a test hook. The decline and rollback path is demonstrated locally and covered by tests.
- **Tradeoff:** the rollback can't be shown on the live demo.

**Full demo seed, loaded only into an empty database**

- **Decision:** the pre-deploy step runs migrations, then `db:seed:if-empty`, which loads the full demo seed (named users plus 300 products and 250 patients) only when there are no users. `db:seed` stays the destructive local reset.
- **Why:** the demo needs enough data for search and pagination to mean something, and redeploying must never wipe what visitors or the demo created.
- **Tradeoff:** the live data drifts as people use the demo; resetting it is a deliberate manual step.

**Stubbed auth on a public URL (accepted risk)**

- **Decision:** the public demo uses the same stub login: anyone with the URL can sign in as any seeded user.
- **Why:** real auth is out of scope for the brief, and all the data is fake. The README and the login screen both say auth is stubbed.
- **Tradeoff:** visitors can create, pay or cancel orders as anyone, so the live data isn't trustworthy and the dashboard totals can change between visits.

## What we cut

- Refunds, cancelling paid orders, and reopening paid orders.
- Provider payouts. The ledger records what's owed; nothing moves money to providers.
- Real payments, auth, email, shipping, tax.
- Date-range filters, CSV export and charts on the dashboard. A platform-wide (admin) revenue view.
- Inventory management. Stock only goes down on payment; there's no restocking path in the app.
- A database-level guard against ledger updates or deletes.
- Automated deploys. Deploys run `railway up` by hand because Railway's auto-deploy supports only GitHub.
- Order status history. Reopen overwrites the earlier send and cancel times.
- Dark mode, responsive layout work beyond the centered column, internationalization.

## What we'd do next

1. Deploy from CI (a GitHub mirror or a CI job with a Railway token) instead of `railway up` by hand.
2. Payment reconciliation for a charge whose transaction never committed, or move to an outbox and webhook flow.
3. Refunds as negative ledger entries, and a payout report per provider.
4. Real authentication and role-based access behind the existing `Auth` interface, with audit logging on PHI reads.
5. A database trigger that makes `ledger_entries` append-only and checks each payment's entries sum to its amount.
6. Rate limiting, structured logging with order and payment ids, and alerting on ledger imbalance or post-charge rollback.
7. Date filters on the dashboard and a platform-level GMV and fee report.
8. Remove the unused paid-orders list from the dashboard API and the unused `lower(name)` indexes.
9. An order events table, so reopen and cancel keep a full status history.
