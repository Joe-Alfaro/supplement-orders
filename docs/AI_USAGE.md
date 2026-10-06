# How AI was used

Almost all of the code in this repository was written by AI agents. My job was product owner and reviewer: I set the requirements, made the calls the agents couldn't, and caught several things they got wrong. This is an account of how that worked, including where it went sideways. It's reconstructed from a decision log kept during the build.

## Tools and setup

- **Agent Orchestrator (AO)** ran the build. One orchestrator session, a Claude Code agent, planned the work, wrote the specs, spawned worker sessions in separate git worktrees, reviewed their branches, and merged accepted work. Workers reported progress and decisions back through AO.
- **Claude Opus 5.5 workers** did the implementation, each scoped to one area: scaffold, domain money module, API, UI, infrastructure and documentation.
- **Grok workers** acted as an independent test author. They wrote the domain tests, the HTTP contract tests, the accessibility and UI state tests, and the Playwright specs, without seeing the implementation.
- **Playwright and axe-core** for end-to-end and accessibility testing. AO's built-in browser panel was used for manual exploratory checks and a real-browser axe run that included color contrast.

Before any code, the orchestrator and I wrote three private planning documents: the brief, an architecture "north star" with each decision marked Proposed or Accepted, and a front-end design covering screens, routes and money display rules. Later we added a domain contract, which fixed function signatures, rounding rules with reference values, error codes and their precedence. A running decision log recorded every notable call. The public docs in this folder are cleaned-up versions of those.

## The workflow

1. **Contract.** The orchestrator writes or updates a contract: signatures, formulas, reference values, error codes.
2. **Red.** A Grok worker writes failing tests from the contract alone.
3. **Green.** A Claude worker implements against the merged tests. It may not edit tests. If it thinks a test is wrong, it files a dispute.
4. **Dispute.** The orchestrator decides whether the test, the implementation or the contract is wrong, logs the ruling, and the owning side makes the change. Grok fixes Grok's tests.
5. **Integrate.** The orchestrator merges branches, often in a throwaway worktree first to check that the combination is green, then re-runs lint, typecheck, unit tests, build, and later the Playwright suite before accepting.

The same loop ran for each product revision after the first build: the fee model (revision 2), search and pagination (3), date-of-birth identification (3b), net margin (4, cancelled), markup (5), cancel and the remaining open items (6), and fee rounding (7). The PrimeVue migration went through it too.

## What worked

**Disagreements between the two models surfaced real gaps in the spec.** On the first run of Grok's 43 HTTP contract tests against Claude's independently built API, 41 passed. The two failures were disputes, not bugs, and one went each way:

- Grok expected a draft priced below cost to save and fail only on send. The API rejected it at save time, which matched an earlier decision, so the API was ruled right and Grok rewrote its test. (That decision was itself reversed later; see "lenient drafts" in [DECISIONS.md](DECISIONS.md).)
- The API attached `field: 'lines'` to an `EMPTY_ORDER` error, and Grok's test expected no field. The test was ruled right, because an empty order is an order-level error that the UI shows in a general banner, and the API changed.

A single model writing both sides would have settled both questions silently, one way or the other, and nobody would have noticed there was a question.

**Grok caught a flawed test bound before it became a test.** For the margin and markup conversions, a draft spec said a percent-to-price-to-percent round trip stays within ±2 basis points. Grok pointed out that this can't hold at low prices: one cent is 99.25 bps of markup on a $1.00 cost, so a correct implementation would fail. The orchestrator replaced the bound with a cost-dependent one, `ceil(5000 / cost) + 1` bps, and brute-checked it over costs from 1 to 20,000 cents and markups from 0 to 100,000 bps before the tests were written.

**Integration caught a hole in the accessibility tests.** Grok's axe suite passed against the original UI. After the switch to PrimeVue, the Claude UI worker merging it noticed that the two Add-product modal tests scanned the component's render container, but PrimeVue's `Dialog` teleports to `document.body`. The modal had never been scanned, and those tests would have passed with an inaccessible modal. Grok fixed its own suite to scan the dialog element and any other teleported overlay. The lesson: a green result from someone else's tests on a changed DOM is worth re-reading, not just re-running.

**A rounding counterexample was found before any code.** When the fee moved out of the provider's markup, the obvious rule was "price >= cost + fee". Before handing it to workers, the orchestrator found that rounding the fee half up per line lets two $0.66 lines priced at $0.66 produce a -$0.01 margin. It derived a minimum price that rounds the per-unit fee up, then brute-checked 200,000 random orders with no negative margin.

**Asking instead of implementing literally.** When I asked for prices to be "calculated from cost plus 75 bps", the agent asked a clarifying question rather than doing it, because a price of exactly cost plus the fee would leave the provider no margin, which the brief requires. That question is what led me to restate the business model correctly (next section).

**Encoding preferences as lint.** My code style preferences (no `for` loops, no `any`, no nested ternaries, Testing Library conventions) were turned into ESLint rules at scaffold time. With several agents writing in parallel, that held up much better than repeating the rules in every prompt.

## What didn't go as expected, and how we corrected

**The first stack proposal ignored the company's stack.** The orchestrator's first proposal was Next.js on Vercel, optimized for deploy speed. I told it the company uses Vue, TypeScript, Postgres and REST, and it revised to Vue 3, an Express REST API and Postgres. The lesson it logged was to ask about the target organization's stack before proposing one.

**The fee model was read wrong, then corrected by me, then corrected by me again.** The agent's first reading had the fee come out of the provider's margin, and it flagged that as an interpretation. I overrode it to charge the fee on top to the patient. After seeing the working slice, I realized my own model was wrong: we're the platform, providers mark up wholesale cost, and the fee should come out of that markup. That reversal invalidated parts of both test suites and cost a full red-green round. Having the money rules in one contract made it cheap.

**A role toggle copied from a demo pattern.** The first design let the user pick "Provider" or "Patient" in a header switcher. I pointed out that a real user has exactly one role. The orchestrator revised the docs to store the role on the user and have the client send only a user id, before any UI or API code existed.

**Search by address.** The agent specified patient search by name or address without asking how clinicians identify patients. I pointed out that date of birth is what they use, and it was changed.

**The AI introduced a rounding inconsistency, and I caught it in the UI.** To make negative margins impossible, the orchestrator's design rounded the per-unit fee up in the minimum-price rule, but kept the charged fee rounded half up "as finance expects". Each rule was right in isolation. On screen, a $5.81 product had a $5.86 minimum and a displayed fee of $0.04, which don't add up. The fix (revision 7) rounds the fee up everywhere. It was brute-checked so that cost + displayed fee equals the minimum for every cost from 0 to 200,000 cents. The lesson the orchestrator logged: when two derived numbers are shown side by side, verify the identity between them, not just each formula.

**Hidden permission prompts stalled workers.** Three of the first five Claude workers sat at "needs input" from their very first command. The orchestrator assumed the stalls were transient and nudged and resumed them, which wasted about 20 minutes. Reading a worker's transcript showed the cause: a permission prompt for a read-only shell command that nobody could see, because the AO-launched workers weren't picking up the project's allowlist. Switching the worker permission mode to `auto` didn't fix it. I chose to run workers in `bypass-permissions` mode, scoped to this project, and the guardrails moved into explicit prompt rules (no push, no PR, no deploy, no destructive commands, no touching other worktrees) plus the orchestrator's review of every branch. The lessons: read the transcript before retrying, and replace a worker that hasn't touched its worktree within a few minutes instead of nudging it.

**AO daemon outage.** The AO daemon stopped for about 18 minutes mid-build. The Grok test worker survived and committed. A scaffold worker that had been stuck since spawn was killed and replaced. Together with the stall, that cost about 35 minutes of scaffold time.

**Messages that didn't arrive.** `ao send` to a Claude worker between turns silently didn't reach it. The orchestrator noticed from the transcript and resent with `--steer`.

**A cancelled revision was written anyway.** Revision 4 (margin net of the fee) was superseded by revision 5 (markup) after I asked why margin had a ceiling. One Grok worker had already committed the revision 4 test suite before it saw the redirect. That branch was simply never merged. Because the tests came first, the cost was only test-writing time, not implementation.

**Tests that went red on purpose.** Several times Grok's tests were deliberately left failing because the app didn't do something yet: a 401 that should send the user to the login screen, a Markup % label that hadn't landed, the rounded-up fee before the domain change. Grok was asked not to loosen an assertion to make it pass, and it didn't. Once, a follow-up pointed a spec back at the old label so the suite would pass. The orchestrator had it reverted, because red was the correct state.

**Strict key-list assertions broke on additive fields.** Grok's contract tests check exact response key lists, so adding a field (such as a patient's date of birth on order detail) broke them several times. Each time Grok updated its own lists. We kept the strictness on purpose: it's what would catch cost or margin accidentally leaking into a patient response.

**A shared test database caused a flake.** One API test timed out once during verification and passed on three reruns. The cause was that every worktree's API tests shared one test database, so concurrent runs truncated each other's data. The fix gives each checkout its own test database, named from an environment variable, the AO session id, or a hash of the repo path.

**Version pin.** The scaffold worker installed the latest Vitest, which crashed npm 10.9's dependency resolver even in an empty project. It bisected the problem, confirmed that npm 11 doesn't have it, and pinned Vitest 3 and Vite 7 rather than asking me to change my npm version.

## Lessons

- **Write the contract before splitting work across models.** Without a shared spec, two models test and build against different guesses. With one, their disagreements point at exactly the parts of the spec that were ambiguous.
- **Keep test authorship separate and binding.** The implementer not being allowed to edit tests was the most valuable rule we had. Every dispute was cheap to resolve and exposed something.
- **Brute-check money rules before dispatching them.** Every rounding rule that survived was checked over hundreds of thousands of cases before a worker saw it. The one inconsistency that shipped came from checking two rules separately instead of checking the relationship between them.
- **Confirm the user's mental model of a number before formalizing it.** Margin versus markup cost a whole revision. One question up front ("do you think in markup on cost or margin on price?") would have saved it.
- **Diagnose agent infrastructure from transcripts, not by retrying.** Most of the time lost to tooling was spent nudging workers that were blocked on something visible in their logs.
- **The human still has to look at the screen.** The two most consequential corrections, the fee model and the rounding mismatch, came from me looking at the running app, not from any test.
