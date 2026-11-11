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
