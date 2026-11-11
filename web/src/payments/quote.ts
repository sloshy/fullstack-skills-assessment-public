import { ApiError } from '../api/client'
import type { SurchargeQuote } from '../api/payments'
import { binOf } from '../utils/card'
import { toMinorUnitsWithExponent } from '../utils/money'

/** How long the terminal waits after the last keystroke before quoting. */
export const QUOTE_DEBOUNCE_MS = 300
/** How long a signed quote lasts after it's issued (docs/quote-contract.md, `expiresAt`). */
export const QUOTE_LIFETIME_S = 300
/** A quote this close to its expiry, or past it, can't be charged. */
// The payments API is meant to accept a quote until 30 s after expiresAt (docs/quote-contract.md);
// stopping 30 s before leaves a minute for the charge to get there.
export const CHARGE_MARGIN_S = 30
/** The terminal re-quotes this long before the quote expires. */
// A little earlier than CHARGE_MARGIN_S, so the new quote usually arrives before Charge turns off
export const REQUOTE_LEAD_S = 35
/** The shortest timer the terminal sets for a quote. */
// Keeps a late or far-off deadline from turning into a tight re-quote loop
export const MIN_TIMER_MS = 5000
/** The longest delay setTimeout accepts; anything longer fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** What gets quoted: a positive amount and the card's first 8 digits. */
export type QuoteInput = {
  amount: number
  bin: string
}

/** The quote input for the form's current values, or `null` if there's nothing to quote yet. */
export const quoteInput = (amount: number | null | undefined, cardNumber: string | null | undefined): QuoteInput | null => {
  const bin = binOf(cardNumber ?? '')
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(amount > 0) || !bin) return null
  return { amount, bin }
}

/** A stable key for a quote input, to tell a current response from a stale one. */
export const inputKey = (input: QuoteInput) => `${input.amount}|${input.bin}`

/** Whether a quote is for this exact amount and BIN. */
// The round trip back to a decimal rejects an amount with more decimals than the currency has
export const quoteMatches = (quote: SurchargeQuote, input: QuoteInput) =>
  quote.bin === input.bin &&
  quote.amountMinor === toMinorUnitsWithExponent(input.amount, quote.currencyExponent) &&
  quote.amountMinor / 10 ** quote.currencyExponent === input.amount

/** A quote and when it arrived, by this machine's clock. */
export type ReceivedQuote = {
  quote: SurchargeQuote
  receivedAtMs: number
}

/** When the quote expires by this machine's clock, in epoch ms; `null` for a fallback quote. */
// expiresAt is the server's clock, which this machine's can be minutes away from. Arrival plus
// the lifetime is late only by the request's latency (seconds), well inside CHARGE_MARGIN_S.
export const localExpiry = ({ quote, receivedAtMs }: ReceivedQuote) =>
  quote.expiresAt === undefined ? null : receivedAtMs + QUOTE_LIFETIME_S * 1000

/** When to re-quote, in epoch ms; `null` for a fallback quote, which doesn't expire. */
export const requoteAt = (received: ReceivedQuote) => {
  const expiry = localExpiry(received)
  return expiry === null ? null : expiry - REQUOTE_LEAD_S * 1000
}

/** The last moment the quote can be charged, in epoch ms; `null` if it doesn't expire. */
export const chargeableUntil = (received: ReceivedQuote) => {
  const expiry = localExpiry(received)
  return expiry === null ? null : expiry - CHARGE_MARGIN_S * 1000
}

/** The setTimeout delay from `nowMs` until `atMs`, kept within MIN_TIMER_MS and MAX_TIMER_MS. */
export const timerDelay = (atMs: number, nowMs: number) =>
  Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, atMs - nowMs))

/** Whether the quote can be charged for this input at `nowMs`. */
export const isChargeable = (received: ReceivedQuote, input: QuoteInput | null, nowMs: number) => {
  if (!input || !quoteMatches(received.quote, input)) return false
  const until = chargeableUntil(received)
  return until === null || nowMs < until
}

/** Whether the quote is the BFF's "no surcharge" fallback (DECISIONS.md 008). */
export const isFallback = (quote: SurchargeQuote) =>
  quote.reason === 'TIMEOUT' || quote.reason === 'UNAVAILABLE' || quote.reason === 'UNKNOWN_MERCHANT'

/** The summary line for the quote's surcharge. */
export const surchargeLabel = (quote: SurchargeQuote) => {
  switch (quote.reason) {
    case null: return `Card surcharge (${quote.rate}%)`
    case 'NOT_CREDIT': return 'No surcharge (debit or prepaid card)'
    case 'UNKNOWN_BIN': return 'No surcharge (card type unknown)'
    case 'MERCHANT_OPTED_OUT': return "No surcharge (merchant doesn't surcharge)"
    case 'TIMEOUT':
    case 'UNAVAILABLE':
    case 'UNKNOWN_MERCHANT':
      return 'Surcharge unavailable. No surcharge will be applied'
    default: return 'No surcharge'
  }
}

/** The latest quote response, for the input it was requested with. */
export type QuoteResult =
  | { key: string } & ReceivedQuote
  | { key: string, error: unknown }

/** What the summary shows. */
export type QuoteView =
  | { kind: 'needs-amount' }
  | { kind: 'needs-card' }
  | { kind: 'quoting' }
  | { kind: 'ready' } & ReceivedQuote
  | { kind: 'invalid-amount' }
  | { kind: 'error', error: unknown }

/** Whether a quote error is the amount being invalid for the currency (a 422). */
export const isInvalidAmount = (error: unknown) => error instanceof ApiError && error.status === 422

/**
 * Works out the summary from the form's values, the latest response and the time. Only a
 * `ready` view can be charged.
 */
export const quoteView = (
  amount: number | null | undefined,
  cardNumber: string | null | undefined,
  result: QuoteResult | undefined,
  nowMs: number,
): QuoteView => {
  const input = quoteInput(amount, cardNumber)
  if (!input) {
    return typeof amount === 'number' && amount > 0 ? { kind: 'needs-card' } : { kind: 'needs-amount' }
  }
  // A response for other values is stale, whatever order the responses arrived in
  if (!result || result.key !== inputKey(input)) return { kind: 'quoting' }
  if ('error' in result) {
    return isInvalidAmount(result.error) ? { kind: 'invalid-amount' } : { kind: 'error', error: result.error }
  }
  // Past its charge deadline the quote is being replaced (the re-quote timer has fired)
  const received = { quote: result.quote, receivedAtMs: result.receivedAtMs }
  return isChargeable(received, input, nowMs) ? { kind: 'ready', ...received } : { kind: 'quoting' }
}
