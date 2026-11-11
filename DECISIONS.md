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
