# Surcharge quote contract (v1)

The contract between the surcharge service, the BFF, the terminal and the
payments API for surcharge quotes. It is fixed before the parallel work starts
(`PLAN.md` Phase 0.5). Background: `DECISIONS.md` 008 (a surcharge problem
never blocks a payment) and 009 (signed quotes).

**Compatibility:**
- Additive by design: existing request and response fields keep their
  names, types and meaning, and new fields are added alongside them. The
  payments API's `SurchargeClient` deserializes into a positional record and
  ignores unknown fields (`SurchargeClient.cs:24`). It fails open (no
  surcharge) on any non-2xx.
- A few status codes do change, deliberately. See [Behaviour changes](#behaviour-changes).

Tests should compare parsed JSON, not text: field order and number
formatting (`185` vs `185.00`) aren't part of the contract.

## Money

- **Exponent:** each currency has an exponent: `USD` 2, `JPY` 0. A currency
  without a known exponent is a configuration error (`500`, logged); there
  is no silent default of 2. The payments API's
  `CurrencyExponents.GetValueOrDefault(currency, 2)` (`SimulatedGateway.cs:82`)
  has the same flaw, which is noted in `NOTES.md`.
- **Valid amount:** an amount is valid when `amount × 10^exponent` is
  exactly an integer. This is a value check, not a scale check: `100.0` JPY
  and `10.000` USD are valid; `100.5` JPY and `10.001` USD aren't.
- **Minor units:** `amountMinor` is that integer (`$185.00` is `18500`,
  `¥1234` is `1234`).
- **Rate:** the merchant's `surchargeRate` (a percent) is read with Scala's
  `BigDecimal(d)`, which uses `Double.toString`. It never uses
  `new java.math.BigDecimal(double)`.
- **Surcharge (rule 3):**
  `surchargeMinor = roundHalfUp(amountMinor × ratePercent / 100)`, computed
  in `BigDecimal`.
- **Total:** `totalMinor = amountMinor + surchargeMinor`, exactly.
- **Decimal fields:** `amount`, `surcharge` and `total` are those
  minor-unit values divided by `10^exponent`, written from `BigDecimal`, so
  they're exact.

## `POST /v1/quotes` (surcharge service)

### Request

The request is unchanged: `{ "merchantId": string, "amount": number, "bin": string }`.
Checks run in this order:

| # | Check | On failure |
| --- | --- | --- |
| 1 | The body is valid JSON with all three fields. | `400 {"error":"invalid_request","details":…}` (unchanged) |
| 2 | `amount > 0` (unchanged, and still checked before the merchant). | `422 {"error":"invalid_amount"}` |
| 3 | `bin`: after removing spaces and dashes, only digits remain, 8 to 19 of them. Only the first 8 are used (a full card number is tolerated so that a client bug can't stop payments), with no zero-padding. `4111abcd…` and anything under 8 digits fail. | `400 {"error":"invalid_bin"}` |
| 4 | `merchantId` exists. | `404 {"error":"unknown_merchant"}` |
| 5 | `amount` is valid for the merchant's currency (see [Money](#money)). | `422 {"error":"invalid_amount"}` |

### Response `200`

The first nine fields already exist; the rest are new.

| Field | Type | Notes |
| --- | --- | --- |
| `merchantId` | string | |
| `currency` | string | |
| `network` | `VISA` \| `MASTERCARD` \| `AMEX` \| `DISCOVER` \| `UNKNOWN` | `UNKNOWN` when the BIN isn't in the table |
| `cardType` | `CREDIT` \| `DEBIT` \| `PREPAID` \| `UNKNOWN` | |
| `surchargeable` | boolean | see [Reason codes](#reason-codes) |
| `rate` | number | percent, `0` when not surchargeable |
| `amount` | number | exact |
| `surcharge` | number | exact |
| `total` | number | exact |
| `currencyExponent` | integer | **new** |
| `amountMinor` | integer | **new** |
| `surchargeMinor` | integer | **new** |
| `totalMinor` | integer | **new** |
| `reason` | string \| null | **new**: `null` when surcharged |
| `bin` | string | **new**: the 8 digits that were looked up and signed |
| `keyId` | string | **new** |
| `expiresAt` | integer | **new**: epoch seconds, issue time + 300 |
| `signature` | string | **new** |

- Every quote the surcharge service returns is signed, including quotes
  with no surcharge.
- An internal failure, such as the BIN lookup throwing, is a `5xx`. It is
  never a `200` dressed up as `UNKNOWN_BIN`.

### Reason codes

`surchargeable` is true only when the merchant has surcharging on with a
rate above 0, **and** the card is credit. Otherwise `rate`,
`surchargeMinor` and `surcharge` are 0 and `reason` is set. The first code
in the table that applies wins.

| Code | Set by | Meaning | Fallback? (alerting) |
| --- | --- | --- | --- |
| `MERCHANT_OPTED_OUT` | surcharge service | rule 6: surcharging is off, or the rate is 0 | no |
| `UNKNOWN_BIN` | surcharge service | rule 2: the BIN isn't in the table, or its card type isn't recognised | no |
| `NOT_CREDIT` | surcharge service | rule 1: debit or prepaid | no |
| `TIMEOUT` | BFF | the quote timed out | **yes** |
| `UNAVAILABLE` | BFF | a network error, `5xx`, an unexpected `4xx`, or an unreadable or incomplete body | **yes** |
| `UNKNOWN_MERCHANT` | BFF | the surcharge service returned `404` (a config fault, alerted separately at higher priority) | **yes** |

## Signature

- **Algorithm:** HMAC-SHA256 over the UTF-8 bytes of this canonical string:

  ```
  v1|{keyId}|{merchantId}|{currency}|{bin}|{network}|{cardType}|{amountMinor}|{surchargeMinor}|{totalMinor}|{expiresAt}
  ```

  - `network` and `cardType` are signed because the payments API stores
    them on the payment (`PaymentService.cs:34-35`). Without a signature,
    a client could record a debit card as credit.
  - All numbers are base-10 integers with no sign, leading zeros or
    decimals.
  - `bin` is exactly 8 digits.
  - No field may contain `|`. Merchant IDs, currency codes, key IDs,
    networks and card types are `[A-Za-z0-9_-]`.
- **Encoding:** the signature is base64url with no padding, from a 32-byte
  MAC.
- **Key:**
  - The key comes from config `surcharge.quoteSigning.key`, overridden by
    the `QUOTE_SIGNING_KEY` env var.
  - The key ID comes from `surcharge.quoteSigning.keyId` / `QUOTE_SIGNING_KEY_ID`.
  - The key must be at least 32 bytes.
  - There's a development default and a startup warning when it's in use,
    the same pattern as `play.http.secret.key`. Refusing to start without
    a real key in production is described in `NOTES.md` but not enforced
    here, because the Docker image runs in production mode and enforcing
    it would break `docker compose up`.
- **Test vector:** both sides must reproduce it.

  ```
  key        = test-only-quote-signing-key-0123456789abcdef   (UTF-8)
  string     = v1|test-1|mer_002|USD|41111111|VISA|CREDIT|18500|463|18963|1767225600
  signature  = _eheNpSMYu68PGi9lBWW-VqEwKqvc2MkL8Sijse2LBU
  ```

  This is INC-4471's payment: $185.00 Visa credit at 2.5% gives a
  surcharge of 4.625, which rounds half up to 463.

## `GET /v1/bins/:bin` (surcharge service)

The same BIN rule applies: only digits, 8 to 19 of them, first 8 used, no
zero-padding. Fewer than 8 digits gets `400 {"error":"invalid_bin"}`. Today
it accepts 6 or 7 digits and pads them with `0`s (`BinController.scala:13`).
Responses are otherwise unchanged.

## `POST /api/surcharge/quote` (BFF → terminal)

**Request:** unchanged, `{ "amount": number, "bin": string }`. The BFF
already enforces `^\d{8}$` (400).

**Response `200`, normal case:**
- It is the surcharge service's response with `merchantId` removed.
  `currency` is now passed through; it used to be stripped too.
- The BFF validates that every field in the response table is present
  with its listed JSON type:
  - string, number, integer or boolean as listed;
  - `reason` may be `null`, and no other field may be;
  - enum values (`network`, `cardType`, `reason`) aren't checked against
    their lists.

  A body that fails this check (for example from an older service during a
  rollout) is treated as unreadable, which means the `UNAVAILABLE`
  fallback.
- The BFF passes every field except `merchantId` through, including fields
  it doesn't know about (a spread, not a whitelist). The terminal echoes
  the object back as `quote`, so it must arrive intact.
- Before any upstream call, the BFF itself rejects a request whose `amount`
  isn't a number > 0, or whose `bin` isn't `^\d{8}$`, with `400` (unchanged).
- Today the BFF test asserts that `currency` is removed
  (`surcharge.controller.test.ts:54`). That test and the web
  `SurchargeQuote` type change with this.

**Fallback (`DECISIONS.md` 008):**
- **When:** a timeout (`SURCHARGE_QUOTE_TIMEOUT_MS`, default `1500`), a
  network error, a `5xx`, any `4xx` other than `400`/`404`/`422`, an
  unreadable or incomplete body, or a `404` from the surcharge service.
  - Any `404` from the service counts as `UNKNOWN_MERCHANT`. A routing 404
    (wrong path or version) would be misreported that way. That's
    accepted, because both mean the service can't serve this merchant and
    both are alerted at high priority.
- **`getMerchant` timeout:** the call uses `PAYMENTS_API_TIMEOUT_MS`
  (default `3000`).
- **Response:** `200` with:

  ```json
  { "currency": "<merchant currency>", "network": "UNKNOWN", "cardType": "UNKNOWN",
    "surchargeable": false, "rate": 0, "amount": <a>, "surcharge": 0, "total": <a>,
    "currencyExponent": <e>, "amountMinor": <m>, "surchargeMinor": 0, "totalMinor": <m>,
    "reason": "TIMEOUT" | "UNAVAILABLE" | "UNKNOWN_MERCHANT", "bin": "<bin>" }
  ```

  It has no `keyId`, `expiresAt` or `signature`: "no surcharge" needs no
  signature.
- **Computing the amounts:**
  - `currency` comes from `getMerchant`, and `e` from the BFF's own
    exponent table (USD 2, JPY 0).
  - `m = Math.round(amount * 10 ** e)`. The amount is valid only if
    `m / 10 ** e === amount`. Otherwise the BFF returns
    `422 {"error":"invalid_amount"}`, the same as the service would.
  - `a = m / 10 ** e`.
- **Where no fallback is possible:**
  - **An unknown currency:** `500`, logged as a config fault.
  - **`getMerchant` fails:**
    - With a `401` (an invalid key), the BFF returns `401`.
    - Any other failure (payments API `5xx`, timeout or network error)
      gets `502 {"error":"upstream_error"}`. Without the merchant there's
      no currency to fall back with, and the payment itself needs the
      payments API anyway.

**Passed through, not a fallback:** a `400` or `422` from the surcharge
service. Only the status is passed through. The body is reduced to
`{"error": …}` by the BFF's error handler, so the service's `details` are
dropped.

## `POST /api/payments` (terminal → BFF → payments API)

**Request:** unchanged, plus one new optional field, `quote`.
- The terminal sends back the quote object exactly as it received it from
  `/api/surcharge/quote`, and the BFF forwards it unchanged.
- The payments API ignores it today: System.Text.Json skips unknown
  properties, and `Program.cs:13` adds only an enum converter.

**What the payments API should do with it** (C#, described in `NOTES.md`,
not implemented here):

1. Take `amount` as `decimal`, not `double`, and work out `amountMinor`
   exactly. Reject the amount if it's invalid for the merchant's currency
   (see [Money](#money)).
2. **Zero surcharge:** if `quote.surchargeMinor == 0` and
   `quote.totalMinor == amountMinor`, charge `amountMinor`, whatever the
   signature or expiry. A zero surcharge can't harm the cardholder, and a
   slow customer on a debit card shouldn't be forced to re-quote.
   - Record `network` and `cardType` only if the signature verifies (step
     3). Otherwise record them as unverified `UNKNOWN`.
   - Record `reason`.
3. **Non-zero surcharge:** rebuild the canonical string from the payments
   API's **own** values where it has them, and take the rest from `quote`:
   - `merchantId`: the authenticated merchant;
   - `currency`: the merchant's;
   - `bin`: the first 8 digits of `CardNumber`, after removing spaces and
     dashes;
   - `amountMinor`: from step 1;
   - `keyId`, `network`, `cardType`, `surchargeMinor`, `totalMinor`,
     `expiresAt`: from `quote`.

   Then require all of these:
   - the `keyId` is known;
   - the signature base64url-decodes to exactly 32 bytes;
   - `CryptographicOperations.FixedTimeEquals` matches the recomputed MAC;
   - `expiresAt + 30 ≥ now`.

   Charge `totalMinor` and record the signed `network` and `cardType`.
4. **Anything else:** a missing `quote`, or a non-zero surcharge that fails
   step 3, gets `409 {"error":"quote_invalid"}`. The terminal then
   re-quotes and shows the new figures. It is never silently re-priced.

**Rollout:**
- Ship the terminal (Phase 2) first, so every request carries a `quote`.
- Run the payments API in a *log-only* mode first: verify, log mismatches,
  but keep re-quoting.
- After that, enforce, keeping a legacy re-quote path behind a flag for a
  deprecation window for direct API callers.

**Until that lands:** the payments API keeps re-quoting at charge time.
The `PLAN.md` Scala-track caveat explains what that leaves unfixed.

## Behaviour changes

None of these breaks a current consumer, but each one is a deliberate
change to an existing response:

| Request | Before | After |
| --- | --- | --- |
| Quote with a BIN of fewer than 8 digits, more than 19, or with characters other than digits, spaces and dashes | `200`, zero-padded or silently stripped, often surcharged as Visa credit | `400 invalid_bin` |
| `GET /v1/bins/` with 6 or 7 digits | `200`, zero-padded guess | `400 invalid_bin` |
| JPY amount with decimals, USD with more than 2 | `200`, surcharge at 2 decimals | `422 invalid_amount` |
| Prepaid card, or a BIN not in the table | `200`, surcharged | `200`, not surcharged (rules 1, 2) |
| An exact half-cent surcharge | rounded half-even | rounded half-up (rule 3) |
| BFF quote when `getMerchant` gets a payments API `5xx` | that status passed through (`UpstreamError`) | `502 upstream_error` |

- **Effect on the payments API:** it accepts JPY amounts with decimals
  today. The web `InputNumber` uses `precision={2}` for every currency.
  Those payments now get a `422` from the quote, and `SurchargeClient` then
  charges them **without** a surcharge (fail-open) and logs a warning.
  Phase 2 fixes the terminal's JPY input. The C# validation is described in
  `NOTES.md`.
- **Replay:** a signed quote can be reused within its 300 s for the same
  merchant, amount and BIN. That gives the same figures a fresh quote
  would. The only difference is a rate change or opt-out inside the window
  (longer still if Phase 3 caches merchant config). Duplicate charges are
  the separate idempotency problem (Task 7).

## Load test note

`scripts/load-test.mjs` sends 2-decimal amounts to `mer_003` (JPY). Under
this contract those get `422`, so the script needs to send whole yen for
`mer_003` before any measurement after Phase 1A. The Phase 0 baseline is
unaffected: it ran against the old service, which accepted them.
