# Notes

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
