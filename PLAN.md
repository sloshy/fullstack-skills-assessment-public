# Plan of attack

Working plan for the assessment. Track: Scala (see `DECISIONS.md` 001). Every
phase ends with an adversarial review subagent, then a commit message drafted
for the candidate's approval (`DECISIONS.md` 005). Parallel phases run in their
own git worktrees and are tested there before merging to `main`.

## Findings that drive the plan

**Task 1: three different numbers.**

| Hop | Where | Bug |
| --- | --- | --- |
| Terminal | `web/src/utils/money.ts:18`, `web/src/pages/NewPaymentPage.tsx:31-45` | Works out its own surcharge from the merchant rate and ignores card type. The server quote is fetched with amount `1`, only to label the card. This explains the debit card shown a surcharge, and the $189.63. |
| Quote | `surcharge-service/app/services/Surcharging.scala:10,16`, `QuoteService.scala:32` | `Double` maths, `HALF_EVEN` rounding, always 2 decimals (wrong for JPY). Prepaid and unknown cards are surcharged. `total` is an unrounded `Double` sum. 4.625 rounds to 4.62, hence the $189.62. |
| Gateway | `payments-api/.../Services/PaymentService.cs:17` | `(long)(quote.Total * 100)` truncates (132.29999999999998 is captured as 13229), and JPY is captured at 100×. This explains Blue Ridge's short deposits. It stays broken even with exact 2-decimal totals: 4,586 of the values from $0.01 to $999.99 truncate wrong (e.g. 4.35 × 100 = 434.99999999999994). **INC-4478 is not fixed until the C# change lands.** |

**Source of truth:** a single server-side quote from the surcharge service. It
is computed in `BigDecimal`, rounded half up to the currency's minor unit, and
only credit cards are surcharged. The terminal shows it; the payments API
charges and stores that same quote as integer minor units, bound to what was
shown (`DECISIONS.md` 008).

**Scala-track caveat:** the payments API isn't changed in this submission. It
ignores unknown JSON fields, still re-quotes at charge time and still
truncates. So the delivered code fixes the terminal and the quote, but rule 4
and INC-4478 are only enforced end to end once the C# changes described in
`NOTES.md` land.

**Task 4:** the payments list cache key is `req.originalUrl` with no merchant
in it (`bff/src/controllers/payments.controller.ts:11,21`), so for 10 s every
merchant sees whoever filled page N. A cache hit also skips the key check:
any non-empty `x-api-key`, including an invalid or revoked one, gets a cached
page. Related, in C#: `PaymentService.GetPayment`
(`payments-api/.../Services/PaymentService.cs:53-54`) has no merchant filter,
so a leaked payment ID can be opened to see another merchant's full payment
detail.

**Task 5:** `quoteSurcharge` (`bff/src/controllers/surcharge.controller.ts`)
is an async Express 4 handler with no try/catch. Any rejection (DNS failure,
an invalid API key giving a 401 from the merchant lookup, non-JSON) is
unhandled, and Node 22 exits the process. There are no fetch timeouts
anywhere.

**Scala Task 2:** `Thread.sleep(5-15ms)` in the merchant lookup on Play's
default dispatcher (`services/onboarding/OnboardingClient.scala:29`), a
linear scan and sort over 221,542 BIN ranges per lookup
(`services/BinTable.scala:16-22`: the cost is the string-compare filter;
the sort only sees the few matches), and synchronous console logging per
quote.

## Phases

### Phase 0: baseline (on `main`, before any change)
- Run `node scripts/load-test.mjs` against `sbt runProd` and record p50, p95,
  p99, max, req/s and errors, with the machine details and the command used.

### Phase 0.5: fix the quote contract (on `main`, before forking)
1A produces the new fields and 1B's fallback emits them, so the contract is
agreed first. It is in **`docs/quote-contract.md`**, which is the source of
truth for:
- field names, types and reason codes;
- validation and status codes;
- the canonical signed string and a test vector;
- the BFF fallback shape;
- the `quote` field on `POST /payments`, and what the payments API should
  do with it.

1A and 1B must both match it; a change to the contract is a change to that
file.

### Phase 1 (in parallel, separate worktrees)

**1A. Surcharge service: Task 1 (Scala side) and Task 3**
- Money as `BigDecimal` end to end, including reading `amount` from JSON
  as `BigDecimal`, never via `Double`. Half-up rounding to the currency's
  minor unit (USD 2 decimals, JPY 0). `total = amount + surcharge`, exact.
- `isSurchargeable` becomes credit only: prepaid and unknown cards are not
  surcharged (rules 1, 2). Opt-out stays (rule 6).
- BIN handling per `docs/quote-contract.md` and `DECISIONS.md` 011, on both
  `/v1/quotes` and `/v1/bins`:
  - only digits, 8 to 19 of them (after removing spaces and dashes), and
    the first 8 are used;
  - fewer than 8 digits gets a 400, and there's no zero-padding;
  - update the 6-digit padding test in `BinTableSpec.scala`;
  - add leniency tests: a full 16-digit card number, a 15-digit Amex, a
    19-digit number, and spaces and dashes all quote the same as the first
    8; 20 digits, letters and 6 or 7 digits get a 400.
- The amount must fit the currency's minor unit.
- Additive contract: keep the existing numeric fields, written from
  `BigDecimal`, and add `amountMinor`, `surchargeMinor`, `totalMinor`, the
  currency exponent, `reason`, and the signature fields from Phase 0.5.
- Sign quotes with HMAC-SHA256 (`javax.crypto.Mac`), matching the test
  vector in `docs/quote-contract.md`. The key and key ID come from config
  or env vars, with a dev default and a startup warning (the same pattern
  as `play.http.secret.key`). Expiry 300 s.
- Update `scripts/load-test.mjs` to send whole yen for `mer_003`.
- Tests for each gap: a half-up tie (185 at 2.5% gives 4.63), JPY whole
  yen, prepaid, unknown BIN, short BIN, exact totals, opt-out total, plus
  signature tests (it verifies, any tampered field fails, expiry is
  present).

**1B. BFF: Task 4 and Task 5**
- Cache key is the merchant ID (resolved through `getMerchant`, so a bad
  key gets the payments API's 401 and not a cached page) plus the
  normalised query. Invalidation is per merchant on create and refund, and
  only on success, so all of a merchant's terminals see fresh data.
  Expired entries are evicted. Add a cache-hit field to the logs.
- Every async route handler is wrapped so errors reach the error
  middleware. Add `unhandledRejection`/`uncaughtException` handlers as a
  last line of defence, with logging and a graceful exit.
- Fetch timeouts (`AbortSignal.timeout`) on both upstream clients. The
  quote uses `SURCHARGE_QUOTE_TIMEOUT_MS` (default 1500). Payments API
  calls, including `getMerchant`, use `PAYMENTS_API_TIMEOUT_MS`.
- The quote endpoint, fallback and pass-through follow
  **`docs/quote-contract.md`** exactly. That covers:
  - the full trigger list, including unexpected 4xx and an
    unreadable or incomplete body;
  - the required-field check;
  - status-only pass-through for 400 and 422;
  - 401 vs 502 when `getMerchant` fails;
  - the exponent-aware `amountMinor` algorithm.
- The response is the service's body with `merchantId` removed and every
  other field passed through (a spread, not a whitelist), so the signed
  fields reach the terminal intact. Update `SurchargeServiceQuote` and
  `SurchargeQuote` (`bff/src/types/index.ts`), and the existing test that
  asserts `currency` is stripped (`surcharge.controller.test.ts:54`).
- Cut for time: a circuit breaker. A short timeout plus the fallback is
  enough here; the breaker is described in `NOTES.md`.
- Tests:
  - two merchants against the cache, and refund invalidation;
  - the process surviving a failed upstream and an invalid API key;
  - timeout, network error, 5xx, unexpected 4xx, incomplete body and
    service 404 each giving the right fallback `reason`;
  - 400 and 422 passing through with status only;
  - a 401 from `getMerchant` staying 401, and other `getMerchant` failures
    giving 502;
  - fallback `amountMinor` for USD and JPY, and a 422 for too many
    decimals.

### Phase 2: web terminal (after 1A and 1B)
Decisions: the receipt mismatch warning (yes), the 504 handling
(`DECISIONS.md` 016, link only, pending expert confirmation), testing
(pure-logic Vitest, no new dependencies) and an automatic re-quote before
expiry. One commit per sub-task (013), in this order:
1. **Safe writes in the client** (`web/src/api/client.ts`):
   - `POST /payments` and refunds don't auto-retry, and their client
     timeout is about 35 s, above the BFF's 30 s write timeout. Reads keep
     their retries.
   - `504 payment_outcome_unknown` gets a distinct warning: "We couldn't
     confirm whether this payment went through. Check the payments list
     before charging again", with a link to the list. The form stays
     filled in, with no retry button (016). Refunds get the same handling.
2. **The quote drives what the customer sees** (Task 1 terminal side,
   Task 3 "shows the customer the right thing"):
   - Quote the real amount and BIN once both are valid, debounced to about
     300 ms, ignoring responses that arrive after the amount or card has
     changed.
   - The summary shows the quote's surcharge and total, formatted from
     its minor-unit fields, with a label taken from its rate and reason.
   - Charge is enabled only for a quote that matches the current amount
     and BIN and hasn't expired. The terminal re-quotes automatically
     about 30 s before `expiresAt`. The button shows the quote's total.
   - The other states: before 8 digits, quoting, the fallback ("Surcharge
     unavailable. No surcharge will be applied", Charge on per 008), a 422
     field error, and a 401/502 error with Charge off.
   - Send the displayed quote unchanged as `quote` in `POST /payments`.
     Remove `previewSurcharge` and the merchant-rate label.
3. **JPY-aware amount input:** the amount input's decimal places come from
   the currency's own digits via `Intl` (0 for JPY, 2 for USD), and the
   placeholder follows.
4. **Receipt mismatch warning:** the payment detail page warns when the
   gateway's captured amount differs from the receipt total, so INC-4478
   is visible to operators until the C# fix lands.
- **Tests:** the quote logic in a small pure module (state, staleness,
  expiry, labels), tested with Vitest, plus the client's retry and
  timeout policy with a stubbed `fetch`. The full flow is checked by hand
  in the integration run.
- **Conventions:** comments per `DECISIONS.md` 015; the web's existing
  ESLint and `tsc` pass; nothing outside `web/` changes.

### Phase 3 (bonus, first to cut): Scala Task 2, latency, in its own worktree
- Measure after each change, one at a time: cache the merchant lookup
  (with a stated TTL: an opt-out or rate change takes effect within it,
  which touches rule 6) or move it to a dedicated blocking dispatcher; binary-search BIN lookup over
  sorted primitive arrays; async logging.
- Record before and after in `NOTES.md`.

### Phase 4: write-up
- `NOTES.md`:
  - Task 1 findings and where the number should come from.
  - The C# changes, described with file, change and reason:
    - integer minor units in `PaymentService.cs:17`;
    - honour the signed quote and stop re-quoting through
      `SurchargeClient`. A non-zero surcharge requires a valid signature:
      fixed algorithm, constant-time compare
      (`CryptographicOperations.FixedTimeEquals`), about 30 s of clock
      skew, a known `keyId`. The signed merchant must be the
      *authenticated* merchant, and the currency the merchant's. The amount
      must match the request, and the BIN must match the first 8 digits
      of `CardNumber` (otherwise a quote signed for a credit card could be
      replayed with a debit card). An explicit "no surcharge" is accepted
      unsigned. A missing `quote`, or a non-zero surcharge with a bad,
      expired or mismatched quote, gets `409 quote_invalid`, so the
      terminal re-quotes and shows the figures again, never silently. The
      payments API reads the shared key from config. In production both
      services should refuse to start without a real key (`DECISIONS.md`
      010). Optionally, reject a non-zero surcharge if the merchant has
      opted out since the quote was issued. Roll out in stages per the
      contract;
    - per-currency exponent;
    - refund amount bookkeeping;
    - the request log recording card data (a PCI issue).
  - Task 4 exposure analysis:
    - **Whose data:** any merchant whose list page was cached. Exposed
      fields: customer names, amounts, last4, network, status and payment
      IDs.
    - **To whom:** any caller sending any non-empty key on the same URL
      within the TTL.
    - **Follow-on:** a leaked ID opens the full payment through the
      unscoped `GetPayment`.
    - **Reconstruction:** the logs can't reconstruct it after the fact (no
      merchant or cache-hit field).
    - **Before replying:** the time window, the replica count, the
      production TTL, log retention, both directions of the leak, and a
      breach-notification assessment.
  - Task 5 monitoring.
  - The Task 7 list, in priority order. Candidates:
    - the unscoped `GetPayment`;
    - card number and CVV in the payments API request log (PCI);
    - duplicate charges (no idempotency, and the web client retries
      POSTs);
    - the BFF `merchantCache` never expiring, so a revoked key keeps
      working;
    - outdated dependencies.
  - What I'd do with more time.
- Task 6: Claude writes review notes for PR #231; the candidate drafts
  `REVIEW.md` (`DECISIONS.md` 007).
