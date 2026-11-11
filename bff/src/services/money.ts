/** Minor-unit exponent per currency (docs/quote-contract.md, "Money"). */
// A currency missing from this table is a configuration error; there is deliberately no
// default of 2 (that is how JPY ends up captured at 100x).
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  JPY: 0,
};

/** The currency's minor-unit exponent, or `undefined` if it isn't in the table. */
export function currencyExponent(currency: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : undefined;
}

/**
 * Converts an amount to minor units: m = Math.round(amount * 10^e), valid only if
 * m / 10^e === amount (a value check, not a scale check: 100.0 JPY is valid, 10.001 USD isn't).
 * amountMinor must also be a safe integer (at most 2^53 - 1, the contract's cap).
 *
 * @returns the amount in minor units, or `undefined` for an invalid amount
 */
export function toMinorUnits(amount: number, exponent: number): number | undefined {
  const scale = 10 ** exponent;
  const minor = Math.round(amount * scale);
  return Number.isSafeInteger(minor) && minor / scale === amount ? minor : undefined;
}

/** Whether totalMinor = amountMinor + surchargeMinor stays a safe integer, as it must. */
export function isSafeTotal(amountMinor: number, surchargeMinor: number): boolean {
  return Number.isSafeInteger(amountMinor + surchargeMinor);
}
