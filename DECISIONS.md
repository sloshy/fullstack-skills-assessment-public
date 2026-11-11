# Decision log

Architectural and process decisions made while working on this assessment, in
chronological order. Each entry: context, decision, and why.

---

## 001 · 2026-11-11 · Scala backend track

**Context:** Part B asks for either the .NET or the Scala track.
**Decision:** Scala track. `surcharge-service/` is worked on locally;
`payments-api/` runs only in Docker. Fixes that belong in the C# service are
described in `NOTES.md` (file, change, reason) rather than made.
**Why:** Scala is the candidate's strongest language, followed by TypeScript.

## 002 · 2026-11-11 · Stay on Scala 2.13 / Play 3

**Context:** The service is on Scala 2.13.18, sbt 1.11.2, Play 3.0.10
(pinned via the Play sbt-plugin). Scala 3 has been the current major version
for some time.
**Decision:** No migration. All work stays on the existing 2.13 toolchain, and
tooling is chosen to support 2.13.
**Why:** A migration is out of scope for the assessment, would make the diff
much larger and harder to review, and has nothing to do with the tickets.
Worth listing as a follow-up instead.

## 003 · 2026-11-11 · Node 22 per `.nvmrc`

**Context:** The machine's default Node is v25; `bff/.nvmrc` and `web/.nvmrc`
pin 22, which matches the Docker images.
**Decision:** Use Node 22 (`nvm use` inside `bff/` and `web/`) for installs,
builds and tests.
**Why:** Matching the pinned and containerised runtime avoids "works on my
machine" differences.

## 004 · 2026-11-11 · Code intelligence: TypeScript LSP + Metals MCP (no Scala LSP plugin)

**Context:** Claude Code has an official TypeScript LSP plugin but no Scala
one. A Metals LSP plugin would by default be rooted at the repo root, while
the sbt build lives in `surcharge-service/`, so Metals would not find the
build.
**Decision:** TypeScript uses the `typescript-lsp` plugin. Scala uses the
standalone `metals-mcp` server (Metals 1.6.9, installed with
`cs install metals-mcp`), registered in Claude Code at local scope over stdio
with `--workspace surcharge-service`. Nothing about it is committed.
**Why:** `metals-mcp` gives compile diagnostics, symbol search, inspect,
usages and test running against an explicitly chosen workspace, and has been
checked against this 2.13 build on 2026-11-11 with a stdio session calling
`import-build`, `glob-search` and `compile-full`, all of which succeeded.
Losing automatic post-edit diagnostics is covered by running `sbt compile` /
`sbt test`.

## 005 · 2026-11-11 · Working agreement for the assessment

- **Commit messages, PR descriptions and similar:** Claude drafts them; the
  candidate reviews and approves before anything is committed or published.
- **Each task:** implemented by subagents. Every change (code or docs) gets an
  adversarial review from a separate subagent before it is committed or
  signed off.
- **Parallel work:** done and tested in its own git worktree, then merged
  back into `main`.
- **Decisions:** recorded here, in order.
- **Remotes:** Bitbucket `origin` is treated as read-only upstream; work is
  pushed to a private GitHub repository.

## 006 · 2026-11-11 · Scala 3 migration is a "with more time" item, not Task 7

**Context:** A Scala 3 migration was first drafted as a Task 7 candidate.
Task 7 asks what to fix before going to production next month.
**Decision:** It goes under "What I'd do with more time" in `NOTES.md`.
**Why:** It doesn't affect business behaviour or production risk; it's
upgrade debt and code health. Task 7 should hold the issues that do.

## 007 · 2026-11-11 · The candidate writes the Task 6 review

**Context:** Task 6 is a review of PR #231, which will be discussed in the
follow-up call.
**Decision:** Claude prepares review notes (findings with file/line and
evidence); the candidate drafts `REVIEW.md` from them and adds anything else
they spot.
**Why:** The review has to reflect the candidate's own understanding of the
issues and judgement on the verdict.

## 008 · 2026-11-11 · A surcharge problem never blocks a payment

**Context:** Rule 4 needs the total shown to equal the total charged; rule 2
says not to surcharge when the card type can't be determined or the lookup
fails. Today the terminal works out its own surcharge, and the payments API
re-quotes when it charges, so a partial outage can make the two disagree
(the preview fails and the charge is surcharged, or the other way round).
Blocking payments while the surcharge service is unhealthy was considered and
rejected.
**Decision:**
- **Fail open on surcharging, never on the payment.** Card not in the BIN
  table, lookup failure, timeout, outage, or an unknown merchant all mean
  *no surcharge*, shown to the customer and charged exactly as shown.
- **Malformed input is a validation error, not a fallback.** A BIN with
  fewer than 8 digits gets a 400 from the quote endpoint (the exact rule is
  in 011). In the terminal that
  means "keep typing", and it is never a reason to refuse a valid card.
- **The charge is bound to what was shown.** The terminal sends the quote
  it displayed (a signed quote, see 009, or an explicit "no surcharge"
  when it fell back). The payments API charges that
  and doesn't re-quote. The Scala/BFF side of this contract is implemented;
  the payments API side is C#, so it is specified in `NOTES.md`.
- **Slow fails fast.** The preview quote has a short time limit (about
  1–1.5 s) and a circuit breaker, so a struggling surcharge service can't
  add latency to every preview.
- **The terminal says what's happening:** "Surcharge unavailable, no
  surcharge will be applied", so the figure shown is literally true.
- **Each cause gets its own reason code** (`UNKNOWN_BIN`, `TIMEOUT`,
  `UNAVAILABLE`, `UNKNOWN_MERCHANT`; a lookup failure inside the service
  surfaces as `UNAVAILABLE`), recorded on the payment. Only the last three
  count as fallbacks for alerting. Alerts
  fire on the fallback rate and its value per merchant, circuit-breaker
  opens, unknown-merchant quotes (a config fault, higher priority), BFF
  5xx/restarts, and a synthetic quote check.
- ~~**Quote IDs aren't signed for now.**~~ Superseded by 009: an unsigned
  binding would let a client claim *any* surcharge, not just fake a
  fallback.

**Why:** The merchant losing a surcharge on payments taken during an outage
costs far less than losing the sale, and rule 2 explicitly prefers not
surcharging when in doubt. What matters is that the shown and charged totals
agree, and that ops learns about a fallback before a merchant does.

## 009 · 2026-11-11 · Quotes are signed (HMAC); "no surcharge" needs no signature

**Context:** 008 binds the charge to what the terminal showed. The plan
review pointed out that if the payments API charges figures sent by the
client with nothing to verify them, a terminal bug, an XSS attack or a bad
actor could submit an inflated surcharge, or one on a debit card or for an
opted-out merchant. That breaks rules 1, 3 and 6 and harms the cardholder.
008's reasoning had only covered a faked fallback, which costs nobody but the
merchant.
**Options considered:**
- **(A) a signed quote**;
- **(B) re-quote at charge time and compare:** this brings back the charge-time
  dependency, and on failure it either blocks the payment (ruled out by 008)
  or diverges from what was shown;
- **(C) stored quotes, redeemed by ID:** this adds state to a stateless
  service. Rejected.

**Decision:** (A).
- The surcharge service signs each quote with HMAC-SHA256 under a key it
  shares with the payments API. The signed text is the canonical UTF-8
  string
  `v1|kid|merchantId|currency|bin|network|cardType|amountMinor|surchargeMinor|totalMinor|expiresAt`
  (network and card type are included because the payments API stores
  them on the payment):
  integers only, `expiresAt` in epoch seconds, signature base64url. The
  key ID is returned as `keyId` so keys can be rotated. The algorithm is
  fixed, never taken from the client. The full contract, with a test
  vector, is `docs/quote-contract.md`.
- The signature and expiry are returned as **new, additive fields**.
  Existing fields don't change. The few deliberate status-code changes are
  listed in `docs/quote-contract.md` ("Behaviour changes").
- The terminal sends the signed quote back in the `POST /payments` body.
  The payments API's JSON binding skips unknown properties (`Program.cs:13`
  only adds an enum converter), so the field is ignored until the C# side
  is built, and nothing breaks.
- The payments API side, described in `NOTES.md` and not implemented:
  - A non-zero surcharge is charged only when its quote has a valid,
    unexpired signature (constant-time compare, about 30 s of clock
    skew). The signed merchant must be the *authenticated* merchant and
    the amount the request's. The BIN must match the first 8 digits of
    `CardNumber`, so a credit-card quote can't be replayed on a debit
    card.
  - An explicit "no surcharge" is always accepted without a signature,
    because a zero surcharge can't harm the cardholder. This keeps 008's
    fail-open behaviour.
  - A bad, expired or mismatched quote is rejected so the terminal
    re-quotes and shows the figures again. It is never silently re-priced.
- The key comes from configuration (an environment variable), with a
  dev-only default for local runs. ~~Production would refuse to start
  without a real key.~~ Superseded by 010: a startup warning instead,
  because the Docker image runs in production mode.

**Why:** It makes the binding verifiable without storing anything. It also
removes the charge-time call to the surcharge service, which helps
availability. And it can ship before the C# change without breaking any
existing consumer.

## 010 · 2026-11-11 · Quote contract choices: signing key, missing quote, unknown currency

**Context:** Choices made while fixing `docs/quote-contract.md` (Phase 0.5).
**Decision:**
- **Signing key:** a development default in `conf/application.conf`,
  overridden by `QUOTE_SIGNING_KEY` / `QUOTE_SIGNING_KEY_ID`, with a startup
  warning while the default is in use. This is the same pattern as
  `play.http.secret.key`. It supersedes 009's "production would refuse to
  start without a real key": the Docker image runs Play in production mode,
  so enforcing that would break `docker compose up` for local runs. The
  refusal is described in `NOTES.md` as a production deployment step.
- **Payment with no `quote`:** once the payments API verifies quotes
  (C#, described only), a payment with no `quote` gets
  `409 quote_invalid`. The rollout goes: the terminal ships first, then
  the payments API verifies in log-only mode, then it enforces, with a
  legacy re-quote path behind a flag for direct API callers.
- **Unknown currency exponent:** a `500` configuration error, never a silent
  default of 2. A default of 2 is how JPY ends up captured at 100×.

**Why:** Keep local development working without weakening the production
story. Make the eventual C# tightening deliberate and staged. Fail loudly
on config faults that would otherwise mis-price every payment.

## 011 · 2026-11-11 · BINs are 8 digits: lenient for longer input, no zero-padding

**Context:**
- `docs/surcharging.md` keys card type on the first 8 digits.
  ISO/IEC 7812-1:2017 moved BINs from 6 to 8 digits, and Visa and Mastercard
  required acquirers to support that by April 2022. Every card number is
  long enough to have 8 digits, whatever its issuer's BIN length.
- Today the service zero-pads shorter input. Measured on
  `conf/bins.csv.gz`, 8,710 six-digit prefixes cover more than one
  network or type. In 4,551 of them, padding with `00` classifies the
  prefix as credit even though some BINs under it are debit or prepaid, so
  it would surcharge them (rules 1 and 2).
- Accepting *exactly* 8 digits was considered. Nothing in the docs requires
  it, and a hard limit would let a client bug (such as sending a full card
  number) stop payments.

**Decision:**
- **Longer input stays lenient:** 8 to 19 digits after removing spaces and
  dashes, with the first 8 used. That's today's behaviour, except that
  today there's no 19-digit cap and letters are silently stripped. It's now written
  into the spec and covered by tests.
- **Fewer than 8 digits, or non-digits, gets `400 invalid_bin`,** on both
  `/v1/quotes` and `/v1/bins`. There's no zero-padding. No real payment can
  hit this, because both callers send 8 digits; in the terminal it means
  "keep typing".
- It is part of Scala Task 3 (Phase 1A), not a "with more time" item.

**Why:** Padding guesses the card type, which is exactly what rule 2
forbids, and it guesses wrong in the direction that harms cardholders.
Lenient handling of longer input keeps the availability stance of 008.

## 012 · 2026-11-11 · Payments list cache key: merchant ID + API-key hash + query

**Context:** Task 4. The BFF cached the payments list under
`req.originalUrl` alone, so every merchant shared one entry per page.
`PLAN.md` 1B first proposed keying on the merchant ID.
**Decision:**
- **Key:** `merchantId` + SHA-256 of the API key + the normalised (sorted)
  query string. The raw key is never stored in a key or logged.
- **Invalidation:** per merchant, on a successful create or refund only.
**Why:**
- **One key per merchant.** `Merchant.ApiKey` is a single, unique column
  (`payments-api/.../Data/Merchant.cs:7,21`), and every terminal of a
  merchant uses it. So adding the key hash costs nothing in hit rate.
- **It closes a revocation gap.** The BFF's merchant cache never expires
  (Task 7 #5). With merchant-only keys, a rotated or revoked key would
  still resolve to the merchant and could be served its cached list. With
  the hash, a key can only hit entries it filled itself. Those expire
  within the TTL, after which its requests reach the payments API and get
  a 401.
- **It still holds if production differs.** Production terminals sign in
  through SSO, so the BFF would derive the key or merchant from the
  session, not the browser. The keying stays correct either way.

## 013 · 2026-11-11 · One commit per task (or meaningful sub-task)

**Context:** Phase 1 was planned as two parallel worktrees. Each touches
two tasks (1A: Tasks 1 and 3; 1B: Tasks 4 and 5), so it would naturally
become one bundled commit. The follow-up call asks for a walkthrough of
each change and the reasoning behind it.
**Decision:**
- Commits are split by task, or by sub-task where there's a meaningful
  checkpoint. Phase 1A becomes Task 1 (exact money), Task 3 (rules and
  BINs) and signed quotes; Phase 1B becomes Task 5, then Task 4.
- Every commit compiles and passes its tests on its own. The last commit's
  tree must exactly match the reviewed version.
- Each commit message is approved separately.

**Why:** Each commit can be explained, reviewed and reverted on its own,
and the history tells the story task by task, not just phase by phase.

## 014 · 2026-11-11 · BFF timeouts, unknown payment outcomes, last-resort error handling

**Context:** Task 5 added timeouts to the BFF's upstream calls. A single
3 s timeout on every payments API call turned the slow test card (about
5 s in the gateway) into a terminal error for a charge that actually
succeeded, because the payments API doesn't cancel the charge. The web
client then retried it into duplicate charges. INC-4493 also showed what
happens when an error escapes: Node exits, and the one shared process
serves every terminal.
**Decision:**
- **Timeouts:** reads (lists, payment detail, merchant lookup) wait 3 s
  (`PAYMENTS_API_TIMEOUT_MS`) and fail with `502 upstream_error`, which is
  safe to retry. Writes (create, refund) wait 30 s
  (`PAYMENTS_API_WRITE_TIMEOUT_MS`).
- **A write whose outcome is unknown** gets `504 payment_outcome_unknown`
  and clears that merchant's cached list. That covers a timeout, a
  connection lost after the request may have been sent, a `2xx` with an
  unreadable body, or a proxy's non-JSON `502`/`503`/`504`. A write that
  can't have been sent (an error while connecting or resolving DNS) is a
  `502`. The terminal must treat the 504 as "check the payments list
  before charging again", never as a retry. The real fix for duplicates
  is an idempotency key (Task 7 #3).
- **Last-resort error handling:**
  - An *unhandled promise rejection* is logged at ERROR
    (`event: "unhandled_rejection"`, alertable), and the BFF keeps
    running.
  - An *uncaught exception* triggers a graceful shutdown and exit
    (forced after 10 s), and Docker restarts it.

**Why:**
- A 502 says "try again". That's wrong for a payment that may have gone
  through.
- After a rejection the process is healthy, and exiting would recreate
  INC-4493 from a single forgotten wrapper. After an uncaught exception
  its state may be corrupt.
- With several BFF replicas behind a load balancer, exiting on both would
  also be reasonable. This system runs one instance, so a restart is an
  outage for every terminal.

## 015 · 2026-11-11 · Doc comments for declarations; plain comments for decisions and surprises

**Context:** The original code uses plain `//` comments throughout, including
to describe values and functions. The Phase 1 code copied that style. It
has about 145 plain comment lines and no doc comments.
**Decision:**
- When a comment describes **what a declaration is or does** (a type,
  value, function, field or config key), it's a doc comment: Scaladoc
  `/** … */` in Scala, TSDoc/JSDoc `/** … */` in TypeScript. That way it
  shows in IDE hovers and generated docs.
- Plain `//` comments are for **why**: a specific decision, a non-obvious
  constraint, or surprising behaviour at that point in the code, ideally
  citing the rule or decision (e.g. `// rule 2: if in doubt, don't`).
- **Scope:** code we write or change. Pre-existing comments in code we
  don't otherwise touch are left alone, to avoid churn in the diff.
**Why:** Doc comments stay attached to the API they describe. A reviewer
can then tell "this is what it is" apart from "this is why it's done this
unusual way", which is the part that needs scrutiny.

## 016 · 2026-11-11 · Unknown payment outcome: link to the payments list, no "charge again" (pending expert confirmation)

**Context:** The BFF returns `504 payment_outcome_unknown` when a payment
write may have reached the payments API but no usable answer came back
(014). The terminal needs to show the operator something. The payments API
has no idempotency key and no lookup by our reference, although the
gateway already supports idempotency keys (`IPaymentGateway.cs`).
**Options:**
- **(A)** Warn and link to the payments list, with no retry button.
- **(B)** Offer "charge again" behind a confirmation.
- **(C)** Offer a retry that reuses the same idempotency key.

**Decision:** (A) for Phase 2. (C) is the intended long-term fix (Task 7
#3), and (B) is rejected. This is **pending confirmation from a payments
domain expert**. The brief for them covers the industry patterns
(idempotency-key retries, a status check before retrying, automatic
timeout reversal), our gaps and their open questions; it's kept outside the
repo as a shared doc.
**Why:** Every established pattern exists to prevent a second
independent charge after an unknown outcome. Without a key, "charge again"
is exactly that. Checking the payments list is the manual equivalent of a
status check; the BFF drops that merchant's cached list on the 504. The
list can't show a charge still running at the gateway, or one captured but
never saved. So the warning tells the operator to wait and refresh, and
shows the amount, last 4 and time, so they can find the entry.

## 017 · 2026-11-11 · The amount field never changes what the operator typed

**Context:** In the integration click-through, antd's `InputNumber` (with
`precision` set from the currency) rewrote invalid input when the field
lost focus. For JPY, `5.5` became `6`. For USD, `10.005` became `10.01`,
and `5fdfsd` became `5.00`. The USD behaviour was already there (the
original field used `precision={2}` for every currency). The JPY rounding
was **introduced by our own Phase 2 commit `a3c597e`**: before it, ¥5.5
reached the server and got a 422; setting the precision to 0 turned that
into a silent round-up. So this is a fix to our own work, and it closes the
pre-existing USD variant in the same field. Rule 4 still held, because the terminal quotes
and charges the rewritten value, but the customer could be charged an
amount nobody typed.
**Options:**
- **(A)** Show a validation error and never rewrite the value.
- **(B)** Block invalid keystrokes.
- **(C)** Keep the rounding but say so.

**Decision:** (A). The amount is a text field (`inputMode='decimal'`), and
its value stays exactly as typed. It must be a plain decimal number with at
most the currency's decimal places (0 for JPY, 2 for USD) and above 0.
Anything else (letters, too many decimals, several points, a negative)
shows a field error such as "Enter whole yen, like 1234" or "Enter an
amount with up to 2 decimal places", and no quote is made or charged until
it's fixed.
**Why:** A money field must never silently change an amount. The usual
practice is to refuse or flag invalid input, not correct it.
