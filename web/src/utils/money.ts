const formatters = new Map<string, Intl.NumberFormat>()

const formatter = (currency: string) => {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency }))
  }
  return formatters.get(currency)!
}

export const formatMoney = (amount: number, currency: string) => formatter(currency).format(amount)

/** The currency's decimal places according to Intl: 2 for USD, 0 for JPY. */
export const fractionDigits = (currency: string) =>
  formatter(currency).resolvedOptions().maximumFractionDigits ?? 2

/** Formats minor units (gateway amounts) with the currency's Intl decimal places. */
export const formatMinorUnits = (minor: number, currency: string) =>
  formatMoney(minor / 10 ** fractionDigits(currency), currency)

/** Formats minor units with an explicit exponent, such as a quote's `currencyExponent`. */
export const formatMinorWithExponent = (minor: number, exponent: number, currency: string) =>
  formatMoney(minor / 10 ** exponent, currency)

/** A decimal amount in minor units for the given exponent, rounded half up to the nearest unit. */
// Shifting the decimal point in the number's text is exact, where 4.35 * 100 gives
// 434.99999999999994 and 1.005 * 100 gives 100.49999999999999. Exponent notation
// (very large or tiny numbers) falls back to multiplying.
export const toMinorUnitsWithExponent = (amount: number, exponent: number) => {
  const text = String(amount)
  return Math.round(text.includes('e') ? amount * 10 ** exponent : Number(`${text}e${exponent}`))
}

/** A decimal amount in the currency's minor units, rounded half up to the nearest unit. */
export const toMinorUnits = (amount: number, currency: string) =>
  toMinorUnitsWithExponent(amount, fractionDigits(currency))

/** The result of reading a typed amount: the number, or what's wrong with the text. */
export type ParsedAmount =
  | { ok: true, amount: number }
  | { ok: false, error: string }

/** What to tell the operator when an amount has the wrong shape for the currency. */
const amountFormatError = (digits: number, currency?: string) => {
  if (digits === 0) return currency === 'JPY' ? 'Enter whole yen, like 1234' : 'Enter a whole amount, like 1234'
  const example = `12.${'3456789'.slice(0, digits).padEnd(digits, '0')}`
  return `Enter an amount with up to ${digits} decimal place${digits === 1 ? '' : 's'}, like ${example}`
}

/**
 * Reads an amount exactly as the operator typed it: digits, optionally a point and 1 to
 * `digits` decimals (no point at all when `digits` is 0), above 0. Surrounding whitespace is
 * ignored.
 */
// DECISIONS.md 017: the amount is never rounded or corrected. Signs, exponents and commas are
// refused rather than read, so the number quoted is always the one on screen.
export const parseAmount = (text: string, digits: number, currency?: string): ParsedAmount => {
  const trimmed = text.trim()
  if (digits > 0 && new RegExp(`^\\.\\d{1,${digits}}$`).test(trimmed)) {
    return { ok: false, error: `Add a 0 before the point, like ${(0.5).toFixed(digits)}` }
  }
  const match = trimmed.match(digits === 0 ? /^(\d+)()$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${digits}}))?$`))
  if (!match) return { ok: false, error: amountFormatError(digits, currency) }
  // Checked on the digits, before Number() can round them: past MAX_SAFE_INTEGER minor units,
  // '99999999999999999' would quietly become 1e17
  const minor = BigInt(match[1] + (match[2] ?? '').padEnd(digits, '0'))
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'That amount is too large' }
  if (minor === 0n) return { ok: false, error: 'Enter an amount above 0' }
  const amount = Number(trimmed)
  // Just under the cap, a decimal can still have more digits than a number holds:
  // 90071992547409.91 becomes 90071992547409.9, a cent less than typed
  if (toMinorUnitsWithExponent(amount, digits) !== Number(minor)) {
    return { ok: false, error: 'That amount is too large' }
  }
  return { ok: true, amount }
}
