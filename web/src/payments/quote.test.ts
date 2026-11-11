import { describe, expect, test } from 'vitest'
import { ApiError } from '../api/client'
import type { SurchargeQuote } from '../api/payments'
import {
  CHARGE_MARGIN_S,
  chargeableUntil,
  inputKey,
  isChargeable,
  isFallback,
  localExpiry,
  MAX_TIMER_MS,
  MIN_TIMER_MS,
  QUOTE_LIFETIME_S,
  QuoteInput,
  quoteInput,
  quoteMatches,
  quoteView,
  ReceivedQuote,
  REQUOTE_LEAD_S,
  requoteAt,
  surchargeLabel,
  timerDelay,
} from './quote'

const EXPIRES_AT = 1767225600

const signed: SurchargeQuote = {
  currency: 'USD',
  network: 'VISA',
  cardType: 'CREDIT',
  surchargeable: true,
  rate: 2.5,
  amount: 185,
  surcharge: 4.63,
  total: 189.63,
  currencyExponent: 2,
  amountMinor: 18500,
  surchargeMinor: 463,
  totalMinor: 18963,
  reason: null,
  bin: '41111111',
  keyId: 'test-1',
  expiresAt: EXPIRES_AT,
  signature: '_eheNpSMYu68PGi9lBWW-VqEwKqvc2MkL8Sijse2LBU',
}

const fallback: SurchargeQuote = {
  ...signed,
  network: 'UNKNOWN',
  cardType: 'UNKNOWN',
  surchargeable: false,
  rate: 0,
  surcharge: 0,
  total: 185,
  surchargeMinor: 0,
  totalMinor: 18500,
  reason: 'TIMEOUT',
  keyId: undefined,
  expiresAt: undefined,
  signature: undefined,
}

const input: QuoteInput = { amount: 185, bin: '41111111' }
/** This machine's clock when the quotes arrive; it agrees with the server's unless a test says not. */
const freshMs = (EXPIRES_AT - 300) * 1000
const received: ReceivedQuote = { quote: signed, receivedAtMs: freshMs }
const receivedFallback: ReceivedQuote = { quote: fallback, receivedAtMs: freshMs }

describe('quoteInput', () => {
  test('needs a positive amount and 8 digits of card number', () => {
    expect(quoteInput(185, '4111 1111')).toEqual(input)
    expect(quoteInput(185, '4111 1111 1111 1111')).toEqual(input)
    expect(quoteInput(185, '4111 111')).toBeNull()
    expect(quoteInput(0, '4111 1111')).toBeNull()
    expect(quoteInput(-1, '4111 1111')).toBeNull()
    expect(quoteInput(null, '4111 1111')).toBeNull()
    expect(quoteInput(undefined, undefined)).toBeNull()
    expect(quoteInput(Number.NaN, '4111 1111')).toBeNull()
  })
})

describe('quoteMatches', () => {
  test('matches the same amount and BIN', () => {
    expect(quoteMatches(signed, input)).toBe(true)
  })

  test('rejects a different amount or BIN', () => {
    expect(quoteMatches(signed, { ...input, amount: 185.01 })).toBe(false)
    expect(quoteMatches(signed, { ...input, bin: '55555555' })).toBe(false)
  })

  test('compares in minor units, so floating-point amounts still match', () => {
    const q = { ...signed, amount: 132.3, amountMinor: 13230 }
    expect(quoteMatches(q, { ...input, amount: 132.3 })).toBe(true)
  })

  test('rejects an amount with more decimals than the currency has', () => {
    const yen = { ...signed, currency: 'JPY', currencyExponent: 0, amount: 100, amountMinor: 100 }
    expect(quoteMatches(yen, { ...input, amount: 100 })).toBe(true)
    expect(quoteMatches(yen, { ...input, amount: 100.4 })).toBe(false)
  })
})

describe('expiry', () => {
  test('expires a lifetime after arrival, re-quotes before that and stops charging at the margin', () => {
    expect(localExpiry(received)).toBe(freshMs + QUOTE_LIFETIME_S * 1000)
    expect(requoteAt(received)).toBe(localExpiry(received)! - REQUOTE_LEAD_S * 1000)
    expect(chargeableUntil(received)).toBe(localExpiry(received)! - CHARGE_MARGIN_S * 1000)
    expect(requoteAt(received)!).toBeLessThan(chargeableUntil(received)!)
  })

  test('a fallback quote never expires', () => {
    expect(localExpiry(receivedFallback)).toBeNull()
    expect(requoteAt(receivedFallback)).toBeNull()
    expect(chargeableUntil(receivedFallback)).toBeNull()
  })

  test("a fast local clock doesn't make a fresh quote look expired", () => {
    // This machine is 10 minutes ahead: by its clock, expiresAt passed 5 minutes ago
    const fast = { quote: signed, receivedAtMs: EXPIRES_AT * 1000 + 5 * 60_000 }
    expect(isChargeable(fast, input, fast.receivedAtMs)).toBe(true)
    expect(isChargeable(fast, input, fast.receivedAtMs + (QUOTE_LIFETIME_S - CHARGE_MARGIN_S) * 1000)).toBe(false)
  })

  test("a slow local clock doesn't keep an old quote chargeable", () => {
    // This machine is 10 minutes behind: by its clock, expiresAt is 15 minutes away
    const slow = { quote: signed, receivedAtMs: freshMs - 10 * 60_000 }
    const deadline = slow.receivedAtMs + (QUOTE_LIFETIME_S - CHARGE_MARGIN_S) * 1000
    expect(isChargeable(slow, input, deadline - 1)).toBe(true)
    expect(isChargeable(slow, input, deadline)).toBe(false)
    expect(deadline).toBeLessThan((EXPIRES_AT - CHARGE_MARGIN_S) * 1000)
  })
})

describe('timerDelay', () => {
  test('counts down from now', () => {
    expect(timerDelay(freshMs + 60_000, freshMs)).toBe(60_000)
  })

  test('never shorter than the floor, so a past deadline cannot loop', () => {
    expect(timerDelay(freshMs, freshMs)).toBe(MIN_TIMER_MS)
    expect(timerDelay(freshMs - 3_600_000, freshMs)).toBe(MIN_TIMER_MS)
  })

  test("never longer than setTimeout's limit, which would fire at once", () => {
    expect(timerDelay(freshMs + 2 ** 40, freshMs)).toBe(MAX_TIMER_MS)
  })
})

describe('isChargeable', () => {
  test('a matching quote before the margin', () => {
    expect(isChargeable(received, input, freshMs)).toBe(true)
    expect(isChargeable(received, input, chargeableUntil(received)! - 1)).toBe(true)
  })

  test('not within the margin of expiry, or past it', () => {
    expect(isChargeable(received, input, chargeableUntil(received)!)).toBe(false)
    expect(isChargeable(received, input, localExpiry(received)! + 1)).toBe(false)
  })

  test('not for different values or no values', () => {
    expect(isChargeable(received, { ...input, amount: 186 }, freshMs)).toBe(false)
    expect(isChargeable(received, null, freshMs)).toBe(false)
  })

  test('a fallback quote can always be charged (DECISIONS.md 008)', () => {
    expect(isChargeable(receivedFallback, input, Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})

describe('surchargeLabel', () => {
  test.each([
    [null, 'Card surcharge (2.5%)'],
    ['NOT_CREDIT', 'No surcharge (debit or prepaid card)'],
    ['UNKNOWN_BIN', 'No surcharge (card type unknown)'],
    ['MERCHANT_OPTED_OUT', "No surcharge (merchant doesn't surcharge)"],
    ['TIMEOUT', 'Surcharge unavailable. No surcharge will be applied'],
    ['UNAVAILABLE', 'Surcharge unavailable. No surcharge will be applied'],
    ['UNKNOWN_MERCHANT', 'Surcharge unavailable. No surcharge will be applied'],
  ] as const)('%s', (reason, label) => {
    expect(surchargeLabel({ ...signed, reason })).toBe(label)
  })

  test('only the BFF reasons are fallbacks', () => {
    expect(isFallback(fallback)).toBe(true)
    expect(isFallback({ ...signed, reason: 'UNKNOWN_MERCHANT' })).toBe(true)
    expect(isFallback({ ...signed, reason: 'UNKNOWN_BIN' })).toBe(false)
    expect(isFallback(signed)).toBe(false)
  })
})

describe('quoteView', () => {
  const key = inputKey(input)

  test('asks for the amount, then the card', () => {
    expect(quoteView(undefined, '4111 1111', undefined, freshMs)).toEqual({ kind: 'needs-amount' })
    expect(quoteView(185, '4111 11', undefined, freshMs)).toEqual({ kind: 'needs-card' })
  })

  test('is quoting until a response for the current values arrives', () => {
    expect(quoteView(185, '4111 1111', undefined, freshMs)).toEqual({ kind: 'quoting' })
  })

  test('ignores a stale response for other values', () => {
    const stale = { key: inputKey({ ...input, amount: 18 }), quote: { ...signed, amount: 18, amountMinor: 1800 }, receivedAtMs: freshMs }
    expect(quoteView(185, '4111 1111', stale, freshMs)).toEqual({ kind: 'quoting' })
  })

  test('ignores a response requested for other values even if its quote happens to match', () => {
    const stale = { key: inputKey({ ...input, amount: 18 }), quote: signed, receivedAtMs: freshMs }
    expect(quoteView(185, '4111 1111', stale, freshMs)).toEqual({ kind: 'quoting' })
  })

  test('is ready with a current quote', () => {
    expect(quoteView(185, '4111 1111', { key, ...received }, freshMs)).toEqual({ kind: 'ready', ...received })
    expect(quoteView(185, '4111 1111', { key, ...receivedFallback }, freshMs)).toEqual({ kind: 'ready', ...receivedFallback })
  })

  test('goes back to quoting once the quote is too close to expiry', () => {
    expect(quoteView(185, '4111 1111', { key, ...received }, chargeableUntil(received)!)).toEqual({ kind: 'quoting' })
  })

  test('a 422 is an invalid amount; anything else is an error', () => {
    const invalid = new ApiError(422, 'invalid_amount', 'invalid_amount')
    expect(quoteView(185, '4111 1111', { key, error: invalid }, freshMs)).toEqual({ kind: 'invalid-amount' })

    for (const error of [new ApiError(401, 'unauthorized'), new ApiError(502, 'upstream_error'), new TypeError('offline')]) {
      expect(quoteView(185, '4111 1111', { key, error }, freshMs)).toEqual({ kind: 'error', error })
    }
  })
})
