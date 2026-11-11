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
1A produces the new fields and 1B's fallback emits them, so the response
shape is agreed first and written into this file:
- Existing fields stay, with exact decimal values: `merchantId`,
  `currency`, `network`, `cardType`, `surchargeable`, `rate`, `amount`,
  `surcharge`, `total`.
- New fields: `currencyExponent`, `amountMinor`, `surchargeMinor`,
  `totalMinor`, `reason` (null when surcharged; otherwise `NOT_CREDIT`,
  `UNKNOWN_BIN`, `MERCHANT_OPTED_OUT`, or the BFF fallbacks `TIMEOUT`,
  `UNAVAILABLE`, `UNKNOWN_MERCHANT`), and `keyId`, `expiresAt` (epoch
  seconds) and `signature`. Fallback codes, which count toward the alerts,
  are `TIMEOUT`, `UNAVAILABLE` and `UNKNOWN_MERCHANT`; the others are
  normal outcomes.
- **Signature (`DECISIONS.md` 009):** HMAC-SHA256 over the canonical
  UTF-8 string `v1|kid|merchantId|currency|bin|amountMinor|surchargeMinor|totalMinor|expiresAt`,
  integers only (no decimals), `expiresAt` in epoch seconds, signature
  base64url. The algorithm is fixed (never taken from the client).
  BFF fallback quotes carry no signature: "no surcharge" needs none.
- `POST /payments` gains an optional `quote` object (the signed quote, or
  an explicit no-surcharge). The payments API ignores it until the C# side
  lands, so nothing breaks.
- Status codes the BFF passes through unchanged: 400 (malformed BIN or
  body) and 422 (an invalid amount, including more decimal places than the
  currency allows).

### Phase 1 (in parallel, separate worktrees)

**1A. Surcharge service: Task 1 (Scala side) and Task 3**
- Money as `BigDecimal` end to end, including reading `amount` from JSON
  as `BigDecimal`, never via `Double`. Half-up rounding to the currency's
  minor unit (USD 2 decimals, JPY 0). `total = amount + surcharge`, exact.
- `isSurchargeable` becomes credit only: prepaid and unknown cards are not
  surcharged (rules 1, 2). Opt-out stays (rule 6).
- `/v1/quotes` requires an 8-digit BIN (a 400 otherwise); no zero-padding
  of short input. The amount must fit the currency's minor unit.
- Additive contract: keep the existing numeric fields, written from
  `BigDecimal`, and add `amountMinor`, `surchargeMinor`, `totalMinor`, the
  currency exponent, `reason`, and the signature fields from Phase 0.5.
- Sign quotes with HMAC-SHA256 (`javax.crypto.Mac`). The key and key ID
  come from config and an environment variable; there's a dev default, and
  the service refuses to start in prod mode without a real key. Expiry
  about 5 min.
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
- Fetch timeouts (`AbortSignal.timeout`) on both upstream clients.
- Preview quote fallback per `DECISIONS.md` 008: on a timeout, network
  error or 5xx, or the surcharge service's 404 for an unknown merchant,
  return an explicit no-surcharge quote with a `reason`. The currency and
  exponent come from `getMerchant`. A 400 or 422 passes through unchanged.
  An invalid API key stays a 401 and never gets a fallback quote.
- Extend `SurchargeServiceQuote`/`SurchargeQuote` (`bff/src/types/index.ts`)
  and the field whitelist in `surcharge.controller.ts`. Today it copies 7
  named fields and drops `merchantId` and `currency`. Pass through
  `currency`, the `*Minor` fields, `currencyExponent`, `reason`, `keyId`,
  `expiresAt` and `signature`. Test it.
- Fallback `amountMinor`/`totalMinor` are computed with exponent-aware
  rounding of the amount (currency from `getMerchant`, whose `Merchant`
  type has it), never `Math.trunc(x * 100)`.
- Cut for time: a circuit breaker. A short timeout plus the fallback is
  enough here; the breaker is described in `NOTES.md`.
- Tests: two merchants against the cache, refund invalidation, the process
  surviving a failed upstream and an invalid API key, timeout leading to
  fallback, 400 passing through.

### Phase 2: web terminal (after 1A and 1B)
- A debounced quote for the real amount and BIN. Show the server's
  surcharge, total and whether it applies; remove `previewSurcharge`.
- While the BIN has fewer than 8 digits, show no surcharge yet ("enter card
  number"). On a fallback, show "Surcharge unavailable, no surcharge will
  be applied".
- Charge is disabled until the displayed quote matches the current amount
  and BIN, so a stale quote can't be submitted.
- Re-quote before `expiresAt`, and disable Charge once a quote has
  expired.
- Send the signed quote (or explicit no-surcharge) as `quote` in the
  `POST /payments` body. Use JPY-aware amount input and formatting.
- Stop the client retrying non-idempotent POSTs (`web/src/api/client.ts`).
  This is a .NET Task 2 concern; noted, with the full fix described in
  `NOTES.md`.

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
      unsigned. A missing, bad, expired or mismatched quote with a
      surcharge is rejected, so the terminal re-quotes and shows the
      figures again, never silently. The shared key comes from config,
      and the service refuses to start without it;
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
