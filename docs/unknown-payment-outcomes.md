# Unknown payment outcomes: what the terminal should do

> **Research note**, written on 2026-11-11 during Phase 2, to inform
> `DECISIONS.md` 016. It draws on public payment-provider documentation
> and on this repository. It is **not** expert confirmation: nobody with
> payments domain expertise has reviewed it, and the questions at the end
> are still open.

## Summary

Proposal: when the terminal can't confirm whether a payment went through, it
tells the operator to check the payments list before charging again, and
offers no "charge again" button. A safe retry needs an idempotency key
carried from the terminal to the gateway, which this system doesn't have yet.

This should be confirmed by a payments engineer or domain expert before it
ships. The questions at the end are what we'd ask them.

## Context

A payment goes terminal → BFF → payments API → card gateway. The gateway can
be slow: one test card takes about 5 s. When a caller stops waiting, the
payments API doesn't cancel the charge. It finishes, captures the card and
saves the payment.

What each layer did when this was written:

| Layer | Behaviour on a slow charge |
| --- | --- |
| Web terminal | Timed out after 4 s and **retried the POST twice**, with no idempotency key. This is a likely cause of the duplicate-charge reports. Phase 2 (`42fb405`) stopped this: writes no longer retry, and wait 35 s. |
| BFF | Waits up to 30 s for a write. If the request may have reached the payments API but no usable answer came back, it returns `504 payment_outcome_unknown`, never a retryable 502. It also drops that merchant's cached payments list (10 s TTL), so the next load reads from the payments API. |
| Payments API | Has no idempotency key and no lookup by our own reference. It charges whatever arrives. |
| Gateway | Already supports an optional idempotency key on charges and refunds, and rejects a reused key with different parameters. It's never given one. |

The open question is what the terminal shows on that 504. The proposal is a
warning: "We couldn't confirm whether this payment went through. Check the
payments list before charging again", with a link to the list, and the form
left filled in. Refunds take the same path and get the same treatment. For
the terminal to see the 504 at all, Phase 2 also stopped the client retrying
POSTs, and raised its POST timeout above the BFF's 30 s.

## Industry practice

Three established patterns, often combined. All three exist to stop a blind
second charge after an unknown outcome.

| Pattern | How it works | Where it's documented |
| --- | --- | --- |
| Retry with the same idempotency key | The client makes one key per payment attempt. A retry after a timeout reuses it, and the server returns the original result instead of charging again. With Stripe, reusing a key with different parameters is an error. Stripe keeps keys for at least 24 hours, Adyen for 7 to 14 days. | [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Stripe advanced error handling](https://docs.stripe.com/error-low-level), [Adyen API idempotency](https://docs.adyen.com/development-resources/api-idempotency) |
| Check the status before retrying | After a timeout, ask whether the attempt happened. Retry the original if the check says it never arrived (NotFound in Adyen's case). Adyen's guidance is for card-present terminals, where the shopper may still be paying, so it shows the pattern rather than our flow. | [Adyen: verify transaction status](https://docs.adyen.com/point-of-sale/basic-tapi-integration/verify-transaction-status), [Adyen POS error scenarios](https://docs.adyen.com/point-of-sale/error-scenarios), [Adyen POS timeouts](https://docs.adyen.com/point-of-sale/error-scenarios/pos-timeouts) |
| Automatic timeout reversal | The terminal or host keeps a reversal record for each online authorisation. If no response arrives, it sends the reversal automatically, so an unconfirmed charge is undone, not repeated. Common on in-person terminals; gateways often offer the same void-on-timeout for card-not-present payments. | [J.P. Morgan payment terminal application](https://developer.payments.jpmorgan.com/docs/commerce/in-store-payments/capabilities/payment-terminal-application/card-transactions), [EFTPOS NZ: what is a reversal](https://support.eftpos.co.nz/what-is-a-reversal) |

Stripe's guidance sums it up: "Don't retry with a new idempotency key until
you've resolved the original outcome."

## Where this system stands

None of the three patterns works end to end yet. The idempotency plumbing
exists only at the bottom of the stack.

| Pattern | Today | What it would take |
| --- | --- | --- |
| Idempotency-key retry | The gateway accepts and enforces a key (`IPaymentGateway.cs`, `SimulatedGateway.cs`). Nothing above it sends one. | The terminal generates a key per attempt. The BFF forwards it. The payments API stores it with a unique constraint and passes it to the gateway. That last part is C#, out of scope for this submission. |
| Status check | No lookup by our own reference. The operator's equivalent is the payments list, whose cached copy the BFF drops for that merchant after a 504. | A lookup by idempotency key or client reference in the payments API. |
| Timeout reversal | Not applicable as built, at least not in our terminal: it's keyed-entry and card-not-present behind a gateway, not an EMV terminal talking to the acquirer. Many gateways void or reverse on timeout for card-not-present payments too. Whether ours does is question 2. | Depends on whether our gateway supports void-on-timeout. See the questions below. |

A "charge again" button today would send a new request with no key, which is
exactly what all three patterns exist to prevent.

## Options and recommendation

Recommended: option A now, with option C as the long-term fix.

| Option | What the operator sees | Risk | Effort |
| --- | --- | --- | --- |
| **A. Link to the payments list only** (recommended now) | A warning plus a link to the list. The form stays filled in. No retry button. | Low, but not zero. It's a manual status check, but the list can't show a charge that's still running at the gateway, or one captured but never saved. The warning tells the operator to wait and refresh, and shows the amount, card's last 4 and time so they can find the entry. Support may still need gateway records. | Small, web only: POSTs stop retrying, the POST timeout goes above the BFF's 30 s so the 504 reaches the terminal, and the 504 shows the warning. |
| B. "Charge again" behind a confirmation | The same warning plus a button that asks "are you sure?" first. | High. Without a key it's a second, independent charge. A confirmation dialog doesn't make that safe. | Small. |
| C. Retry with the same idempotency key (long term) | "Retry" is safe: a repeat returns the original result. | Low once built end to end, provided the payments API returns the stored payment for a repeated key without charging or saving again, and the key store is durable with a set retention window. The simulator's store today is in memory, with no expiry. | Medium: the terminal and BFF are small changes; the payments API change is C#. |

One optional step now: the terminal could generate a key per attempt and send
it, and the BFF could forward it. The payments API would ignore it until the
C# side lands, which keeps everything additive. It's held back until the
key's format and lifetime are decided (question 3).

## Open questions

1. We believe this is a card-not-present terminal (keyed entry, MOTO-like).
   Does that change which reversal options exist?
2. Does our gateway or acquirer support void-on-timeout, or a status lookup by
   our own reference or idempotency key?
3. Who should generate the idempotency key, the terminal or the BFF? How long
   should it stay valid (Stripe keeps keys for at least 24 hours, Adyen 7 to
   14 days), and what should a reuse with different parameters return? The
   simulator rejects it.
4. What should front-desk staff do on an unknown outcome? Does support have a
   process for refunding duplicates?
5. Are there network or acquirer rules about re-presenting a card after an
   unconfirmed authorisation?
6. Is option A acceptable to ship before the idempotency work, or should the
   payment flow wait for it?

## Sources

Each claim was checked against these pages during review. The Adyen POS
pages describe card-present terminals. The J.P. Morgan page confirms only
that the terminal keeps a reversal record and sends it automatically; it
doesn't support the exact timing.

- [Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe: Advanced error handling](https://docs.stripe.com/error-low-level)
- [Stripe blog: Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- [Adyen: API idempotency](https://docs.adyen.com/development-resources/api-idempotency)
- [Adyen: Verify transaction status](https://docs.adyen.com/point-of-sale/basic-tapi-integration/verify-transaction-status)
- [Adyen: POS error scenarios](https://docs.adyen.com/point-of-sale/error-scenarios)
- [Adyen: POS timeouts](https://docs.adyen.com/point-of-sale/error-scenarios/pos-timeouts)
- [J.P. Morgan: Payment terminal application, card transactions](https://developer.payments.jpmorgan.com/docs/commerce/in-store-payments/capabilities/payment-terminal-application/card-transactions)
- [EFTPOS NZ: What is a reversal](https://support.eftpos.co.nz/what-is-a-reversal)

System details come from the repository:
`payments-api/.../Gateway/IPaymentGateway.cs`, `SimulatedGateway.cs`, the
BFF's write-timeout handling, and `web/src/api/client.ts`.
