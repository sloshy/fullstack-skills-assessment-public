# Notes

This is the write-up for the InterPayments senior fullstack assessment,
Scala track. The decisions behind it are logged in order in
[`DECISIONS.md`](./DECISIONS.md). The working plan is [`PLAN.md`](./PLAN.md),
and the shared quote contract is
[`docs/quote-contract.md`](./docs/quote-contract.md). The PR #231 review is
in [`REVIEW.md`](./REVIEW.md).

## Overview

### What I did

| Task | Status | Where |
| --- | --- | --- |
| 1: terminal vs receipt vs gateway | Fixed in the surcharge service, BFF and terminal. The payments API (C#) fix is specified below. | `c85c097`, `5318c26`, `0c13b75`, `90d09a8`, `d24da26` |
| Scala Task 3: surcharge rules | Done, with tests per gap | `73b54c2` (and the rule 3/4 tests in `c85c097`, `5318c26`) |
| Scala Task 2: latency under load | Done: baseline, then three fixes each measured on its own (≥8× throughput, p50 76 → 9 ms) | `3e89a1a` (baseline), `bc75e4c`, `ff79e75`, `96ddf15` |
| 4: someone else's payments (BFF) | Done | `4f844a6` |
| 5: everyone's terminal goes down (BFF) | Done (the "bonus" BFF task) | `0c13b75`, `10edfda` |
| 6: review of PR #231 | `REVIEW.md` | |
| 7: what I'd fix first | Below | |
| .NET Tasks 2 and 3 | Not done (Scala track); approach below | |

Two pieces of work span the tasks:
- **Signed quotes** (`5318c26`, `DECISIONS.md` 009): the terminal can
  prove which surcharge it showed.
- **Safe writes in the terminal** (`42fb405`): no automatic retries, and an
  explicit "outcome unknown" state.

Follow-ups:
- comment conventions (`40a10d3`, `e8dc953`);
- an amount-field fix found during the integration run (`97db531`).

### How I worked, and how the AI-written code was checked

- **What I did myself.**
  - I made the design decisions. Each one is logged with its reasoning in
    `DECISIONS.md`. Several are where I pushed back on or redirected the
    first proposal:
    - **Fail open (008).** I argued that a surcharge problem should never
      hold up a payment, and that failures should be caught by monitoring
      instead. I also pushed back on rejecting payments with bad BINs:
      rule 2 says "don't surcharge", not "don't take the payment".
    - **Signed quotes (009).** I ruled out adding state to the payment
      path, and asked for a design that doesn't break the existing APIs,
      since the C# service gets no fixes in this exercise.
    - **Lenient BIN parsing (011).** I questioned truncating card numbers
      and asked what the documented BIN length is. I argued against a hard
      block: a client bug that sends extra digits shouldn't halt payments.
      So the leniency is now specified and tested.
    - **List cache key (012).** I asked whether terminals share API keys
      before we settled the key. They do: each merchant has one key for all
      its terminals, so adding the key hash costs nothing in hit rate.
    - **One commit per task (013).** I split the phase-sized commits we'd
      planned, so each one can be explained on its own.
    - **Doc comments (015).** Doc comments for declarations, `//` only for
      why.
    - **Unknown outcomes (016).** I asked for industry practice before
      deciding, and wanted a domain expert to confirm the result. The
      research is in `docs/unknown-payment-outcomes.md`. It isn't expert
      confirmation, so 016 stays pending.
  - I did the integration click-through myself. That's where I found the
    amount field silently rewriting what I typed ("5.5" yen became 6,
    "5fdfsd" became 5.00 dollars). I asked for a validation error instead,
    and for it to be fixed now rather than listed, because it's dangerous
    (017).
  - Scope calls:
    - Scala 3 and dependency upgrades are separate "more time" items.
    - Property-based tests (I'm a proponent) and the missing linters are
      also "more time" items.
    - BFF ESLint is its own commit.
    - `NOTES.md` has a short section for each task, not just Tasks 1
      and 2.
  - I wrote `REVIEW.md` from Claude's review notes, reading the PR in my
    editor. Claude filled in the later sections along the lines I'd
    started, and I reviewed them. Along the way:
    - I proposed doing the filtering in the database query, so the
      separate list of every merchant's payments goes away. That simplified
      the suggested fix.
    - I turned down a fuller rewrite (grouping in SQL) as too much for a
      review comment. Before mentioning it as a follow-up, I had it
      benchmarked to see what it would gain.
    - I asked where the refunded amount in minor units would come from. It
      comes from the payment's status, since refunds are always full.
    - I raised the `useEffect` data fetching against React's "You Might
      Not Need an Effect" guidance.
    - I recommended dropping the report cache rather than fixing its key.
  - I approved every commit message, and trimmed one that was too detailed.
  - I reviewed the commits.
- **Agents and reviews.** I used Claude Code throughout.
  - Implementation went to agents in separate git worktrees.
  - Every change, code or docs, then went through a **separate review
    agent**. Reviews ran again after each round of fixes. Reviewers were
    told to verify by running things, not to trust the implementer's
    report.
  - Examples of what that caught:
    - a 3 s BFF write timeout that would have turned the slow test card into
      triple charges;
    - card digits leaking through Express's JSON parse errors;
    - unsigned `network`/`cardType` fields in the quote signature.
- **The contract came first.** It was fixed in
  `docs/quote-contract.md` before the parallel work started, with a
  signature test vector that both the Scala and the TypeScript tests check
  against.
- **Commits.**
  - Each commit is one task or meaningful sub-task (`DECISIONS.md` 013),
    and compiles and passes its own tests.
  - When work was split into several commits, applying the series to a
    fresh copy of `main` gave an empty `diff` against the reviewed code.
- **Integration run.** After the unit tests, I ran the full stack in Docker
  and clicked through it by hand. That caught a regression one of our own
  commits had introduced (`DECISIONS.md` 017).

## Task 1: "The terminal said one thing, the receipt said another"

### Causes

There were three different numbers, and none of them was reliably right:

| Hop | Where | What was wrong | Ticket |
| --- | --- | --- | --- |
| Terminal | `web/src/utils/money.ts` (`previewSurcharge`), `NewPaymentPage.tsx` | It worked out its own surcharge from the merchant rate with `Math.round` (half up) and ignored card type. The server quote was fetched with amount `1`, only to label the card. | INC-4471: the terminal's **$189.63**, and the **debit card shown a surcharge** |
| Quote | `surcharge-service/app/services/Surcharging.scala`, `QuoteService.scala` | `Double` maths, `HALF_EVEN` rounding, always 2 decimals. `total` was an unrounded `Double` sum. | INC-4471: the receipt's **$189.62** (4.625 rounded half-even to 4.62) |
| Gateway | `payments-api/…/Services/PaymentService.cs:17` | `(long)(quote.Total * 100)` truncates: 128.45 + 3.85 = 132.29999999999998 becomes 13229. It also multiplies JPY by 100. | INC-4478: Blue Ridge's deposits come in **a few cents short** |

The seed data shows the same:
- Of the 487 approved or refunded payments, **69 were captured at a
  different amount from the receipt**: all 48 JPY payments at 100×, and 21
  USD payments a cent short (18 Blue Ridge, 3 Harbor).
- 55 USD surcharges aren't half-up (for example 111.50 at 3% stored as 3.34),
  and 31 of the 48 JPY payments have a fractional-yen surcharge.
- 40 of the 43 prepaid payments carry a surcharge.

### Where the number should come from

**From the surcharge service's quote: one figure, computed once on the
server, carried unchanged to the terminal, the receipt and the gateway.**
- The quote is the only place that knows both the card type (BIN table)
  and the merchant's settings, so it's the only place that can apply rules
  1–3 and 6.
- It's computed in **integer minor units**, rounded half up to the
  currency's own exponent (USD 2, JPY 0), with
  `total = amount + surcharge` exactly.
- The terminal **shows** that quote, and the payment request carries it
  back.
- The payments API should **charge and store** that same figure as an
  integer, not recompute it, not re-quote, and not multiply a double.

Rule 4 ("we must charge exactly the total they were shown") is only
guaranteed if the charge is bound to what was shown. So every quote is
**signed** (HMAC-SHA256 over the merchant, BIN, network, card type, minor
amounts, currency, key ID and expiry). A terminal bug or a malicious client can't then submit
a surcharge the server didn't produce. "No surcharge" needs no signature,
because it can't harm the cardholder (`DECISIONS.md` 009, 010).

### What changed (this submission)

- **Surcharge service:**
  - `BigDecimal` from JSON parsing onwards.
  - Minor units, half-up rounding and the currency exponent; an amount
    with too many decimals gets a 422, and an unknown currency is a logged
    500.
  - New `*Minor` fields, a `reason`, and a signature on every quote.
  - All of it is additive, so the existing C# client keeps working
    (`docs/quote-contract.md`).
- **BFF:** passes the quote through unchanged, apart from removing
  `merchantId`.
- **Terminal:**
  - Quotes the real amount and BIN, ignores stale responses and re-quotes
    before expiry.
  - Shows the quote's figures and sends that quote with the payment.
  - Charge is enabled only for a current quote that matches the amount and
    card.
  - The payment detail page warns when the gateway's captured amount
    differs from the receipt, so INC-4478 is visible to operators until the
    C# fix lands.

**Integration evidence** (full Docker stack, through the BFF):
- Harbor $185.00 Visa credit: quote, receipt and capture are all
  **$189.63 / 18963**.
- Debit and prepaid cards get `NOT_CREDIT` and no surcharge.
- ¥1234 at 3% gives a **¥37** surcharge.

### What still needs the payments API (C#), not changed here

I'm on the Scala track, so these are specified, not made. Until they land,
the payments API keeps re-quoting and truncating. The integration run still
showed a **$4.35 debit payment captured as 434** cents, and **¥1271
captured as 127100**.

| File | Change | Reason |
| --- | --- | --- |
| `Services/PaymentService.cs:17` | Charge the quote's integer `totalMinor`. If you must convert, use `decimal` and round to the currency's exponent, never `(long)(double * 100)`. | Truncation (INC-4478) and JPY captured at 100× |
| `Contracts/Payments.cs` `CreatePaymentRequest` | Take `amount` as `decimal`, and accept the optional `quote` object | Exact amounts, and binding the charge to what was shown |
| `PaymentService.cs:14` / `SurchargeClient` | Verify the quote instead of re-quoting: HMAC-SHA256 with `FixedTimeEquals`, a known `keyId`, unexpired with about 30 s of skew. The merchant, currency, BIN and amount must be the request's own. A zero surcharge with `totalMinor == amountMinor` is accepted unsigned, recording `reason`, with network and card type `UNKNOWN` unless signed. Anything else, including a missing quote, gets `409 quote_invalid`. | Rule 4, end to end |
| `Program.cs:17` (`SurchargeClient` registration) | Interim, until the row above lands: give the client a timeout **below the BFF's 1.5 s** (it uses `HttpClient`'s 100 s default today) | Otherwise the terminal can show a "no surcharge" fallback while the payments API's slower re-quote succeeds and charges one (see Task 5) |
| `Data/Payment.cs` and the contracts | Store money as integer minor units with the currency exponent, and migrate existing rows | `double` everywhere (Task 7 #3) |
| `Gateway/SimulatedGateway.cs:82` | Don't default an unknown currency to 2 decimals (`GetValueOrDefault(currency, 2)`). It only affects display today; charging already rejects unknown currencies. | The same silent-default pattern that caused the JPY bugs |
| `PaymentService.cs:79,85` | Record the refunded **minor** amount actually sent to the gateway, not `payment.Total` | Receipts and reports drift from deposits |

Roll out the quote verification in stages: the terminal first, which
already sends the quote; then the payments API in log-only mode; then
enforcement, with a legacy re-quote path behind a flag for direct API
callers.

## Scala Task 3: surcharge rules

### Gaps found, and the test that now catches each

All tests are in `surcharge-service/test/`.

| Rule | Gap in the original code | Test that would have caught it |
| --- | --- | --- |
| 1: credit only | `isSurchargeable = cardType != Debit`, so **prepaid was surcharged** | prepaid 48471800 gets `NOT_CREDIT`, surcharge 0 |
| 2: if in doubt, don't | A BIN not in the table fell back to `Unknown` and **was surcharged**. Short BINs were zero-padded and classified (`"4"` became Visa credit). | BIN 63900000 gets `UNKNOWN_BIN`; 6/7/20 digits and letters get 400 |
| 2: if in doubt, don't (narrowest range) | Padding a 6-digit prefix guessed the card type. 8,710 of the table's 6-digit prefixes contain a narrower range of a different type. In 4,551 of them, padding with `00` picks credit even though some BINs under the prefix are debit or prepaid. | the `normalize` and `/v1/bins` tests (`DECISIONS.md` 011) |
| 3: half up, minor unit | `HALF_EVEN` to 2 decimals in `Double`, so ¥ amounts had fractions | 18500 at 2.5% gives **463** (it was 462); ¥1250 at 3% gives **38**; a 2.3% exact tie; ¥ with decimals gets 422 |
| 4: exact total | `total = amount + surcharge` in `Double` (132.29999999999998) | 128.45 at 3% gives exactly **13230** minor; the not-credit, unknown-BIN and opt-out quotes are all signed |
| 6: opt-out | Correct, but only tested via a merchant that was both disabled **and** at 0%. A 0% rate with surcharging on was untested. | surcharging on at 0% gets `MERCHANT_OPTED_OUT` |

The test suite went from 17 to 57 tests (74 after Phase 3): the signature test vector, tamper
and expiry tests, the BIN leniency set, the amount cap, and a lookup
failure giving a 500.

### The terminal shows the customer the right thing

- The summary, label and total come from the quote for **this card and
  this amount**: "Card surcharge (2.5%)", "No surcharge (debit or prepaid
  card)", "No surcharge (card type unknown)" or "No surcharge (merchant
  doesn't surcharge)".
- Until there's a valid amount and 8 card digits, it says so, and Charge
  stays off.
- The amount field never rewrites what the operator typed. This was found
  in the integration click-through: antd rounded `5.5` JPY up to `6`. That
  rounding was introduced by our own commit `a3c597e`; the USD equivalent
  (`10.005` became `10.01`) was there before (`DECISIONS.md` 017).

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

### After: three fixes, each measured on its own

**Method:** the same as the baseline.
- **Setup:** `sbt runProd`, the same machine, the Docker stack stopped.
- **Runs:** a 5 s warm-up, then 3 × 20 s runs at 64 workers, and one 10 s
  single-worker run. The server was restarted for each state, and the
  table shows the run with the median throughput of the three.
- **Starting point:** S0 is `main` at `97db531`, with all the correctness work
  and no performance changes. It's the fair starting point, because the
  load test now sends whole yen for JPY.

| State | Throughput (64 workers) | p50 | p99 | max | Single-worker p50 | Server CPU | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Original baseline (`b335265`) | 790/s | 75.9 ms | 188.8 ms | 1182 ms | 17.6 ms | ~3.5 cores | 0 |
| **S0**: correctness work, no performance changes | 824/s | 75.6 ms | 187.7 ms | 964 ms | 28.9 ms | ~3.6 cores | 0 |
| **S1**: + merchant lookup off the request threads, cached | 999/s | 59.2 ms | 178.7 ms | 354 ms | 9.0 ms | **~9–10 cores** | 0 |
| **S2**: + binary-search BIN lookup | **6,714/s** | **8.7 ms** | **28.3 ms** | 107 ms | 3.9 ms | ~1.7 cores | 0 |
| **S3**: + asynchronous logging | 6,575/s | 8.7 ms | 32.2 ms | 114 ms | 3.3 ms | ~1.7 cores | 0 |

**What each step shows:**
1. **S0 → S1: the merchant lookup** (`MerchantDirectory`).
   - **The change.** The onboarding call blocks for 5–15 ms, standing in
     for a network call. It now runs inside `blocking {}` on its own
     16-thread Pekko dispatcher, not Play's shared 12-thread default. Found
     merchants are cached for a configurable TTL (default 30 s; `0` turns
     the cache off), and concurrent misses share one call.
   - **What it showed.** The server stopped being starved of threads, but
     throughput rose only about 20%. CPU went from ~3.6 to ~9–10 of 12
     cores, and `jstack` showed every request thread in the BIN scan's
     `Vector.filter`. Fixing one bottleneck exposed the next.
   - **Trade-off (rule 6).** An opt-out or rate change now takes up to the
     TTL (30 s, `MERCHANT_CACHE_TTL`) to reach new quotes, plus up to 300 s
     for quotes already issued. Unknown merchants and failures aren't
     cached, so they still reach onboarding every time.
   - **Left as is:** the onboarding queue is unbounded and the call has no
     timeout, as before this change. A flood of unknown merchant IDs, or a
     hung onboarding service, would queue without limit. The next step
     would be a timeout and a bounded queue that fails fast.
2. **S1 → S2: the BIN lookup** (`BinTable`).
   - **The change.** Every quote used to scan all 221,542 ranges with
     string comparisons. At load, the ranges are now cut into disjoint
     segments, each holding its narrowest covering range, so a lookup is
     one binary search with no allocation. That's **6.7× S1's throughput,
     and over 8× the baseline**. Both are lower bounds, because the load
     generator becomes the limit. The p99 fell from ~180 ms to ~28 ms.
   - **Correctness.** It's checked against the original linear scan, kept
     as a test-only reference, on the real table: every test card, every
     range's start, end and one either side, and 200,000 seeded random
     BINs. A deliberate off-by-one makes it fail.
3. **S2 → S3: asynchronous logging** (logback `AsyncAppender`,
   `neverBlock`).
   - **What it showed.** No measurable change, which is within noise.
     Under `runProd`, stdout goes to a pipe and rarely blocks.
   - **Why keep it.** It's insurance, not a speed-up: a slow log
     destination (a terminal, a backed-up Docker log driver) can no longer
     stall request threads.
   - **Trade-off.** Under extreme load, log lines are dropped rather than
     blocking.

**At S2 and S3 the load generator is the limit, not the service.**
- The single Node process runs at ~135% CPU, while the service uses ~1.7
  of 12 cores.
- With two generators (2 × 32 workers), the service handled about
  **12,400–15,900/s at a p50 of ~4 ms** (p99 ~12–15 ms), using ~3.3 cores
  with ~44% of the machine idle.
- What's left is spread out: Pekko HTTP, JSON, BigDecimal and the HMAC.

**Caveats:**
- The single-worker p50 at S0 (28.9 ms, against 17.6 ms in the original
  baseline) wasn't investigated; the 64-worker figures match the baseline.
- Run-to-run variation is about ±10% at S1, where the service and the load
  generator compete for CPU. From S2 on, including the two-generator
  runs, each run was slightly slower than the one before; I didn't
  investigate why.
- Before and after should come from the same session. The original
  single-worker baseline was measured in an earlier session, so compare
  single-worker numbers from S0 onwards.
- The S3 two-generator run happened before S2's, so the S2 run needed the
  logging change reverted first. The saved output can't confirm that it
  was. Either way, the difference between them is within the drift.
- Raw output was kept locally, not committed.

## Task 4: "Someone else's payments" (INC-4486)

### What happened

- **The bug.** The BFF cached the payments list under `req.originalUrl`
  alone for 10 s (`payments.controller.ts`). The URL doesn't include the
  merchant, which travels in the `X-Api-Key` header. Every terminal requests
  the same `?page=1&pageSize=20`.
- **The effect.** The first merchant to load page 1 filled the cache. For
  the next 10 s, every merchant asking for page 1 got that merchant's list.
  When the entry expired, Harbor's next refresh fetched its own list again,
  which is exactly "refreshed a few seconds later and their own payments
  were back".
- **No key check on a hit.** A cache hit returned before any upstream call,
  and the BFF only checks that a key is *present*. So even an invalid or
  revoked key would have been served a cached page.
- **Over-invalidation.** `createPayment` cleared every merchant's entries,
  even on a failed create, and refunds didn't invalidate at all.

### The fix (`4f844a6`, `DECISIONS.md` 012)

- **Cache key:** merchant ID + a SHA-256 of the API key + the allow-listed
  `page`/`pageSize`. An entry is only ever served to the key that filled it,
  and a bad key gets the payments API's 401, which is never cached.
- **Invalidation:** per merchant, only on a successful write or an unknown
  outcome. A fill that raced an invalidation isn't stored. Expired entries
  are evicted, and the cache is capped.
- **Request logs:** now carry `merchant_id` and cache `hit`/`miss`, so an
  incident like this can be reconstructed.
- **Integration run:** Harbor and Blue Ridge each got 20 payments with zero
  overlap, and an invalid key got 401.

The caching stays, as the payments API team asked.

### Whose data could have been exposed, and to whom

- **Whose:** any merchant whose payments list page filled the cache. For
  each row that's the customer name, date and time, amount, surcharge and
  total, refunded amount, status and decline reason, card network and type,
  last 4 digits, payment ID, gateway reference and captured amount. For a
  dental practice, a visit time tied to a patient name is personal data. No full card numbers: the list never holds them.
- **To whom:** any caller sending **any non-empty API key** for the same
  page and page size within 10 s of the fill. That includes:
  - every other merchant;
  - a revoked key;
  - anyone who could reach the BFF with a made-up key.
- **Both directions.** Harbor saw another merchant's data, and Harbor's own
  list was almost certainly served to others when Harbor filled the cache.
- **Follow-on exposure.** The list holds payment IDs, and
  `GET /api/payments/{id}` has **no merchant filter** in the payments API
  (`PaymentService.cs:53-54`, Task 7 #2). So a leaked ID could be opened to
  see that payment's full detail.

### What I'd need to know before replying to Harbor

- **The time window.** When was the BFF version with this cache deployed,
  and when was it fixed?
- **The topology.** How many BFF replicas ran? The cache is per process,
  which changes who could have seen what. And what was the production
  `PAYMENT_LIST_CACHE_TTL_MS`?
- **The logs.** What retention is there, and what can they show? Before
  this fix the BFF's request log had **no merchant and no cache-hit
  field**, so the BFF alone can't say which merchant's data went to whom.
  You'd have to correlate BFF hits with payments API `GET /api/payments`
  calls by time, plus any ingress or proxy logs with client IPs or
  sessions.
- **Merchants and data.** Which merchants were active in the window,
  exactly which fields were exposed, and whether any detail pages were
  opened via leaked IDs (payments API logs for `GET /api/payments/{id}`).
- **Obligations.** This is customer personal data, so involve privacy or
  legal first, for a breach-notification assessment under GDPR and US state
  laws and the merchant contracts. Find out whether the card brands need
  telling; with no full card numbers, PCI impact is likely limited, but
  confirm. Agree the message to *every* affected merchant, not just
  Harbor, because their data went the other way too.

## Task 5: "Everyone's terminal goes down" (INC-4493)

### Why one failed call took down every terminal

- **The bug.** `quoteSurcharge` was an `async` Express 4 handler with no
  try/catch. Express 4 ignores the promise a handler returns, so any
  rejection became an **unhandled rejection**, and Node 22 exits on those.
- **The effect.** The BFF is a single process serving every terminal, so
  every in-flight and new request failed until Docker restarted it, a few
  seconds later.
- **Deploys.** During a surcharge-service deploy the container's DNS name
  briefly doesn't resolve (`ENOTFOUND surcharge-service`), and that
  triggered it.
- **"But not always" — other triggers in the same handler:**
  - an **invalid API key**: the merchant lookup threw on its 401;
  - any 404 or 5xx from the surcharge service;
  - a non-JSON error page from a proxy;
  - a payments API outage.
- **No timeouts.** There were no fetch timeouts anywhere, so a slow
  dependency would also have hung requests.

### What changed (`0c13b75`, `10edfda`, `DECISIONS.md` 008, 014)

- **Every route** is wrapped, so errors reach the error middleware.
- **Both upstream clients** have timeouts and parse responses safely.
- **Process guards:**
  - An unhandled rejection is now **logged and survived**: one forgotten
    wrapper mustn't recreate the outage.
  - An uncaught exception drains connections and exits, since state may
    be corrupt.
  - With several BFF replicas, exiting on both would also be reasonable;
    with one, a restart is an outage.
- **Lint guard:** type-aware ESLint (`no-misused-promises`,
  `no-floating-promises`) now fails the build on an unwrapped async
  handler. It flags PR #231's new route, for example.
- **Payment writes:**
  - Writes wait 30 s, because the payments API doesn't cancel a charge.
  - A write that may have happened but got no usable answer returns
    `504 payment_outcome_unknown`, never a retryable 502.
  - The terminal never auto-retries writes, and on an unknown outcome
    tells the operator to check the payments list (`DECISIONS.md` 016).
- **Cut for time:** a circuit breaker on the surcharge client. The 1.5 s
  timeout plus the fallback already limit the damage, at the cost of 1.5 s
  per preview while the service is down. With a breaker:
  - after a run of consecutive failures (say 5), it would open for about
    30 s and return the `UNAVAILABLE` fallback immediately, with no call;
  - then it would let one probe through, and close again on success;
  - "breaker open" would be its own alert.
- **Integration run:** with the surcharge service stopped, quotes fell back
  and a payment went through. The BFF logged it with **0 restarts**.

### What the terminal does when the surcharge service is slow or down (rule 4)

A surcharge problem never blocks a payment (`DECISIONS.md` 008).
- **When:** the quote times out (1.5 s), returns 5xx, 404 or an unexpected 4xx, or returns a body the BFF can't read.
- **What the BFF returns:** an explicit "no surcharge" quote with a
  reason (`TIMEOUT`, `UNAVAILABLE` or `UNKNOWN_MERCHANT`).
- **What the terminal shows:** "Surcharge unavailable. No surcharge will be
  applied", and the charge goes through at the shown total.
- **Why that's the right behaviour:** rule 2 prefers not surcharging when
  in doubt, and a lost surcharge costs the merchant far less than a lost
  sale.
- **A gap in rule 4 until the C# change lands:** the payments API still
  makes its *own* quote at charge time, with no timeout. So the shown and
  charged totals can still disagree:
  - if the BFF's preview times out at 1.5 s but the payments API's slower
    re-quote succeeds, the customer is charged a surcharge they weren't
    shown;
  - in the reverse case (the preview succeeds, the charge-time quote
    fails), they're shown a surcharge and not charged it.

  In our integration run the service was down for both quotes, so they
  agreed. The interim fix is a timeout on the C# `SurchargeClient` below
  the BFF's. The real fix is charging the signed quote that was shown,
  which removes the second quote (Task 1's C# table).

### How we'd find out in production before a merchant does

- **Crash and restart signals:**
  - BFF container restarts.
  - Any `unhandled_rejection` or `uncaught_exception` log event.
  - Both page on-call.
- **Fallback rate:** from the `surcharge_fallback` log field, per merchant
  and per reason. Alert when it rises above a small baseline;
  `UNKNOWN_MERCHANT` alerts at higher priority, as a config fault. The
  surcharge lost through fallbacks can be estimated from it for finance.
- **Unknown payment outcomes:** the rate of
  `event: payment_outcome_unknown` and BFF 504s. Every one is a possible
  duplicate-charge conversation.
- **Shown ≠ charged:** compare the `totalMinor` of the quote the terminal
  sent with the total the payments API returns, at the BFF. Any mismatch is
  a rule 4 breach (the gap above) and should alert.
- **Daily reconciliation:** the gateway's captured amounts against the
  receipts. That catches INC-4478-class drift before a merchant's
  bookkeeper does.
- **Error and latency:**
  - BFF 5xx rate and p95/p99 per route.
  - Surcharge-service p99 latency against the 1.5 s timeout.
  - Payments API latency against the 30 s write timeout.
- **A synthetic check:** every minute, quote a known merchant and BIN
  through the BFF and assert the expected surcharge. That catches "up but
  wrong" too.
- **Deploys:** the surcharge service should roll out with readiness checks
  (old instance kept until the new one is healthy), so its DNS name never
  disappears. A dependency-aware `/health` on the BFF would let the
  orchestrator see it too; today `/health` always says ok.

These need metrics and alerting that the repo doesn't have yet. The logs
are now structured to feed them (Task 7, smaller items).

## .NET tasks (not done: Scala track)

- **.NET Task 2, duplicate charges:**
  - **The contract.** An `Idempotency-Key` header, generated once per
    payment attempt by the terminal and forwarded by the BFF.
  - **Storage.** The payments API stores `(merchantId, key)` with a unique
    constraint, plus a hash of the request. A repeat with the same body
    returns the stored response without charging again; a different body
    gets 409, and one still in flight gets 409 "in progress".
  - **The gateway.** It already supports an idempotency key
    (`Gateway/IPaymentGateway.cs`), so pass the same key down.
  - **Retention.** Keys are kept for at least 24 h.
  - **Cases:**
    - a client timeout and retry;
    - a double-click;
    - the same request replayed from another tab;
    - the BFF's 504;
    - a crash between capture and save. The gateway has no lookup by key,
      so recovery replays `Charge` with the same key, and the gateway
      returns the original result.

  The terminal side of "never auto-retry" is already in (`42fb405`).
- **.NET Task 3, partial refunds:**
  - **Data.** A `Refund` table: payment ID, amount minor, surcharge minor,
    gateway reference, created-at, idempotency key.
  - **Concurrency.** SQLite has no row locks, so reserve the amount with a
    conditional update before calling the gateway:
    `UPDATE … SET refunded_minor = refunded_minor + @x WHERE id = @id AND refunded_minor + @x <= captured_minor`.
    Check that one row was affected, or use a row version. Two concurrent
    refunds can't both pass. Each refund also gets its own gateway
    idempotency key.
  - **Proportional surcharge (rule 5).** Use cumulative rounding: refund
    surcharge = round(cumulative refunded × surcharge ÷ amount) − surcharge
    already refunded. The running total then never exceeds the surcharge
    charged, without needing to know which refund is last.
  - **Terminal.** An amount field on the refund dialog.
  - **A property test** that no sequence of partial refunds can exceed
    either total.

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
3. **Money is stored and passed around as `double`.** C# `double`, SQLite
   `REAL`, and JSON numbers through the BFF and web. This is what's left
   after Task 1, which fixes how the figures are calculated and charged,
   not how they're stored. *Why it matters:* the
   Task 1 fix makes the figures exact where they're calculated and shown,
   and charging is only exact once the described C# change lands. Even
   then, the payments API stores and sums doubles. Refunds, reporting
   and settlement (PR #231) will keep reintroducing errors of a cent.
   *Fix:* store integer minor units (or `decimal`) with the currency
   exponent in the database and the API contracts, and migrate the
   existing rows. Add property tests that totals always equal the sum of
   their parts.
4. **Merchant config is duplicated and partly never refreshed.**
   - The surcharge rate and currency are held in two places, the payments
     API's merchants (`Data/seed.json`) and the surcharge service's
     `conf/merchants.json`, with nothing keeping them in step. They agree
     today. The payments API has no opt-out flag, though: it models opt-out
     as rate 0, while the surcharge service has an explicit
     `surchargeEnabled`.
   - Separately, the BFF's `merchantCache`
     (`bff/src/services/merchantService.ts:14,28-49`) has no TTL. A revoked key
     keeps working for `/merchants/me` and quote previews, and a changed
     currency is never picked up.

   *Why it matters:* the two copies will drift, for example when someone
   opts out in one place only. Then the preview, the charge and the
   records disagree on whether to surcharge (rule 6) or on currency, which
   breaks minor-unit amounts. *Fix:* one
   source of truth for merchant config, a TTL plus invalidation on change
   in the BFF, and a consistency check between the services.

Duplicate charges are not ranked here because they're .NET Task 2, which
this Scala-track submission doesn't implement (see `DECISIONS.md` 014 and
016 for what the terminal and BFF do meanwhile).

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
      Phase 3 already checks this on the real table with seeded random
      BINs; a property test would also generate the overlapping ranges
      themselves.
  - **BFF (fast-check):**
    - `toMinorUnits` agrees with a decimal-string oracle;
    - under random interleavings of fills, writes and invalidations, the
      cache never serves an entry across merchant or key.
  - **Payments API (FsCheck):** across any sequence of partial refunds,
    the total surcharge refunded never exceeds the surcharge charged
    (rule 5). Task 7 #3 would also want "totals always equal the sum of
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
