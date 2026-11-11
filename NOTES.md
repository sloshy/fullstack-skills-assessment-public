# Notes

## Scala Task 2: latency under load

### Baseline (before any change)

Measured on `b335265` (unmodified surcharge service) with
`sbt runProd`, JDK 21.0.9, on WSL2 (12 logical CPUs, 19 GB RAM). The load
generator is `scripts/load-test.mjs` (Node 22) on the same machine. One 5 s
warm-up run is discarded, because the script itself doesn't warm up the JVM.

| Run | Workers | Duration | Requests | Throughput | p50 | p95 | p99 | max | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 64 | 20 s | 15,832 | 790/s | 75.9 ms | 146.4 ms | 188.8 ms | 1181.7 ms | 0 |
| 2 | 64 | 20 s | 15,903 | 793/s | 76.4 ms | 143.6 ms | 176.3 ms | 1005.0 ms | 0 |
| 3 | 64 | 20 s | 15,806 | 789/s | 76.6 ms | 141.8 ms | 174.5 ms | 1087.0 ms | 0 |
| single | 1 | 10 s | 567 | 57/s | 17.6 ms | 22.5 ms | 23.2 ms | 48.7 ms | 0 |

**What it shows:**
- With one worker (run after the warm-up), a request takes about 17.6 ms
  end to end. About 10 ms of that is the merchant lookup's
  `Thread.sleep(5-15 ms)` (`services/onboarding/OnboardingClient.scala:29`).
  The rest is the linear scan of 221,542 BIN ranges
  (`services/BinTable.scala:16-22`), HTTP and the client.
- Under 64 workers the server uses only about 310–370% CPU (3–3.7 of 12
  cores), yet throughput is stuck at about 790/s, so it isn't CPU-bound.
  The numbers fit a fixed-size thread pool:
  - **Pool size:** Play's injected `ExecutionContext` is Pekko's default
    dispatcher. In `pekko-actor` 1.0.3 it is a fork-join pool with
    `parallelism-factor = 1.0`, `min = 8`, `max = 64`, so 12 threads here.
    Neither Play's `reference.conf` nor `conf/application.conf` overrides
    it. The merchant lookup `Future`, the BIN lookup and Pekko HTTP's
    request handling all share those 12 threads.
  - **The pool can't grow:** `Thread.sleep` isn't wrapped in `blocking {}`,
    so the fork-join pool never adds compensation threads, and the
    ceiling stays fixed.
  - **Thread time per request:** 12 threads / 790 per second ≈ 15.2 ms,
    which is consistent with about 10 ms of sleep plus a few ms of work.
  - **CPU per request:** 3.5 cores / 790 per second ≈ 4.4 ms, which
    matches the non-sleep share.
  - **Little's law:** 64 in flight / 790 per second ≈ 81 ms, consistent
    with the 76 ms p50. That is queueing behind blocked threads.
- So the bottleneck is threads blocked in `Thread.sleep` on the shared
  default dispatcher. The BIN scan is the next cost once that's removed.
- **Caveats:**
  - The load generator runs on the same machine, but about 8 cores stay
    idle, so it isn't starved.
  - WSL2 adds virtualisation and timer jitter.
  - The ~1–1.2 s max outliers are unexplained (possibly GC, JIT or WSL
    scheduling; not investigated).

Reproduce: `cd surcharge-service && sbt runProd`, wait for
`curl localhost:9000/health`, then
`node scripts/load-test.mjs --duration 5` (warm-up, discarded) and
`node scripts/load-test.mjs` three times.

## Task 7: What would you fix first?

In priority order, beyond what this submission fixes.

1. **Card number and CVV are written to the payments API logs.**
   `RequestLoggingMiddleware` (`payments-api/.../Infrastructure/RequestLoggingMiddleware.cs:12-21,27-28`,
   registered at `Program.cs:32`) logs every request body, and
   `CreatePaymentRequest` carries `CardNumber` and `Cvv`. It logs after
   the response, so after authorization, and it logs requests that failed
   validation too.
   *Why it matters:* PCI DSS forbids storing CVV after authorization under
   any circumstances, and the full card number has to be protected wherever
   it's stored. Logs get copied to aggregators, backups and developer
   machines, so this alone can put the ability to accept cards at risk.
   *Fix:* stop logging request bodies; log an allowlist of fields and mask
   the card number to the last 4 digits. Purge and rotate the existing logs,
   and treat it as a possible incident (find out where the logs went).
2. **Any merchant can read any payment by ID.**
   `PaymentService.GetPayment` (`payments-api/.../Services/PaymentService.cs:53-54`)
   looks the payment up by ID alone, with no merchant filter, and
   `GET /api/payments/{id}` exposes it (`Controllers/PaymentsController.cs:27`).
   *Why it matters:* any valid API key can fetch another merchant's payment
   detail (customer name, amounts, card network and last 4, gateway
   reference, captured amount). Payment IDs leaked
   through the BFF cache (Task 4) lead straight to it. Refunds are scoped to
   the merchant; reads aren't. *Fix:* filter by the authenticated merchant
   and return 404, not 403, so the payment's existence isn't revealed.
   Add tests, and audit every endpoint for the same pattern.
3. **Duplicate charges.** Creating a payment has no idempotency key.
   Before this submission the web client also retried `POST /payments` on
   timeout or 5xx (`web/src/api/client.ts:4,19-22`). We stop that, but a
   double-click, a page reload or the BFF retrying can still create two
   charges. *Why it matters:* customers get charged two
   or three times, the most visible kind of money harm and a source of
   chargebacks. It's .NET Task 2, which this Scala-track submission doesn't
   implement. *Fix:* the terminal generates an idempotency key once per
   payment attempt. The payments API enforces it with a unique constraint
   (merchant + key) and replays the stored response for a repeat, with a
   conflict for the same key with a different body or one still in flight.
   Clients never auto-retry non-idempotent requests without a key.
4. **Money is stored and passed around as `double`.** C# `double`, SQLite
   `REAL`, and JSON numbers through the BFF and web. *Why it matters:* the
   Task 1 fix makes the figures exact where they're calculated and shown,
   and charging is only exact once the described C# change lands. Even
   then, the payments API stores and sums doubles. Refunds, reporting
   and settlement (PR #231) will keep reintroducing errors of a cent.
   *Fix:* store integer minor units (or `decimal`) with the currency
   exponent in the database and the API contracts, and migrate the
   existing rows. Add property tests that totals always equal the sum of
   their parts.
5. **Merchant config is duplicated and partly never refreshed.**
   - The surcharge rate and currency are held in two places, the payments
     API's merchants (`Data/seed.json`) and the surcharge service's
     `conf/merchants.json`, with nothing keeping them in step. They agree
     today. The payments API has no opt-out flag, though: it models opt-out
     as rate 0, while the surcharge service has an explicit
     `surchargeEnabled`.
   - Separately, the BFF's `merchantCache`
     (`bff/src/services/merchantService.ts:5-18`) has no TTL. A revoked key
     keeps working for `/merchants/me` and quote previews, and a changed
     currency is never picked up.

   *Why it matters:* the two copies will drift, for example when someone
   opts out in one place only. Then the preview, the charge and the
   records disagree on whether to surcharge (rule 6) or on currency, which
   breaks minor-unit amounts. *Fix:* one
   source of truth for merchant config, a TTL plus invalidation on change
   in the BFF, and a consistency check between the services.

Smaller items noted but not ranked: health checks don't check dependencies,
and there are no metrics or alerting (partly addressed under Task 5).
Refunds record `payment.Total` while sending `GatewayAmountMinor` to the
gateway (.NET Task 3 territory).

## What I'd do with more time

- **Upgrade outdated dependencies.** On a clean `npm ci` (Node 22),
  `npm audit` reports 13 vulnerabilities in `web/` (2 critical, 1 high,
  10 moderate) and 9 in `bff/` (7 low, 2 moderate). Both install the
  deprecated `glob@7`. The Scala and .NET dependencies haven't been audited
  yet. These are mostly version bumps. PCI DSS v4.0 (req. 6.3.3) expects
  critical and high-severity patches within a month, so it would move up
  the Task 7 list if triage shows any of them reachable at runtime.
  *Approach:* triage (reachable at runtime, or dev/build only), upgrade the
  direct dependencies, re-run the test suites. Once the tree is clean, add
  automated updates (Dependabot/Renovate) and CI audit gates
  (`npm audit --audit-level=high`, the OWASP Dependency-Check sbt plugin,
  `dotnet list package --vulnerable`).
- **Migrate the surcharge service to Scala 3.** This is a separate and much
  larger job than the version bumps above. It's on Scala 2.13.18 / Play 3.
  Play 3 already supports Scala 3, so the work is in our own code: implicits,
  macros and syntax across the whole codebase, which needs re-evaluating as
  a whole. *Why:* new language development happens in Scala 3, while 2.13
  only gets maintenance releases, and libraries and tooling increasingly
  target Scala 3 first. It doesn't affect business behaviour, which is why
  it isn't on the Task 7 list (`DECISIONS.md` 002, 006). *Approach:*
  incremental and test-driven. Turn on `-Xsource:3` and the scala3-migrate /
  Scalafix rewrites on 2.13 first, cross-build to 3.x, then switch over.
  The proof that behaviour hasn't changed is the existing test suite plus
  characterization tests on the quote endpoint (golden request/response
  pairs across the BIN table and the merchant fixtures). AI assistance pays
  off here: it can do the mechanical rewrites and generate the
  characterization tests that show the migrated service behaves the same.
- **Keep dev-only merchant keys out of production builds.** The terminal's
  merchant dropdown (`web/src/merchants/devMerchants.ts`) hard-codes every
  merchant's API key. Its comment says it's dev only and that production
  signs in through SSO, but nothing enforces that: there's no
  `import.meta.env.DEV` guard, and the web image runs the Vite dev server.
  Gate the dev merchants behind a build flag, and serve a production build,
  so the keys can't ship to a terminal.
- **Close the linting and formatting gaps.** No service has a formatter
  (scalafmt, Prettier, `dotnet format`), and there's no CI pipeline,
  pre-commit hook or root `.editorconfig`.
  - **Scala:** scalafix isn't set up. Unused-code warnings are explicitly
    off (`-Xlint:-unused,_`), and warnings aren't fatal.
  - **Web:** ESLint runs without type-aware rules, and unused variables
    and `exhaustive-deps` are only warnings.
  - **C#:** no `.editorconfig`, analyzer level, `EnforceCodeStyleInBuild`
    or warnings-as-errors.
  - **Approach:** adopt each formatter in its own formatting-only commit,
    so real changes aren't buried in reformatting. Then turn on stricter
    analysis per service (re-enable unused warnings with `-Werror`, the
    .NET analyzers, type-aware ESLint for the web app), and run all of it
    in CI on every PR. The BFF already got the one guard that mattered
    for INC-4493: type-aware ESLint with `no-misused-promises` and
    `no-floating-promises`.
- **Add property-based tests.** None of the stacks has a property-testing
  library. This system is full of invariants that example-based tests only
  sample:
  - **Surcharge service (ScalaCheck):**
    - for any valid amount, rate and currency, `totalMinor` equals
      `amountMinor + surchargeMinor`;
    - the surcharge equals a half-up oracle computed from decimal
      strings, and is never negative;
    - non-credit cards always get 0;
    - a signature verifies, and changing any single field breaks it;
    - any 8–19-digit input with spaces and dashes inserted normalises to
      its first 8 digits;
    - the BIN lookup agrees with a brute-force narrowest-range oracle.
      That last one is especially valuable for checking a faster lookup
      against the original linear scan.
  - **BFF (fast-check):**
    - `toMinorUnits` agrees with a decimal-string oracle;
    - under random interleavings of fills, writes and invalidations, the
      cache never serves an entry across merchant or key.
  - **Payments API (FsCheck):** across any sequence of partial refunds,
    the total surcharge refunded never exceeds the surcharge charged
    (rule 5). Task 7 #4 would also want "totals always equal the sum of
    their parts".
- **Add component tests for the terminal.** The web app has Vitest but no
  DOM testing, so Phase 2 tests its logic as pure modules: quote state and
  expiry, the client's retry and timeout policy, write-error
  classification, and money. The React hook and pages that wire those
  modules up are untested. A regression in the Charge block after an
  unknown outcome, in clearing a rejected quote, or in the request-cancel
  and timer cleanup would pass every test today. Those were checked by hand
  in the integration run. *Approach:* add React Testing Library + jsdom and
  a handful of page-level tests for the new-payment and refund flows, with
  `fetch` stubbed and fake timers.
