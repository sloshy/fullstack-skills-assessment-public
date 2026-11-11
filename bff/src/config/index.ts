import { logEvent } from '../logger';

/**
 * Reads a positive whole number from the environment variable `name`.
 * Unset or empty means `fallback`. Anything else must be a whole number > 0: "30s" or "1.5"
 * is rejected and falls back to `fallback` with a WARN.
 */
// Not parseInt: it would quietly read "30s" as 30 ms.
export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;

  logEvent('WARN', 'config', `Ignoring ${name}=${JSON.stringify(raw)}: not a positive whole number, using ${fallback}`);
  return fallback;
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  paymentsApiUrl: process.env.PAYMENTS_API_URL || 'http://localhost:5080',
  surchargeServiceUrl: process.env.SURCHARGE_SERVICE_URL || 'http://localhost:9000',
  paymentListCacheTtlMs: positiveIntFromEnv('PAYMENT_LIST_CACHE_TTL_MS', 10000),
  /** Timeout for the surcharge preview quote. */
  // docs/quote-contract.md: the preview quote fails fast and falls back to "no surcharge"
  surchargeQuoteTimeoutMs: positiveIntFromEnv('SURCHARGE_QUOTE_TIMEOUT_MS', 1500),
  /** Timeout for payments API reads, including the merchant lookup. */
  paymentsApiTimeoutMs: positiveIntFromEnv('PAYMENTS_API_TIMEOUT_MS', 3000),
  /** Timeout for non-idempotent payments API writes (create, refund). */
  // The payments API doesn't cancel a charge when we give up, and some gateway paths take
  // ~5 s, so this must be well above any real charge time.
  paymentsApiWriteTimeoutMs: positiveIntFromEnv('PAYMENTS_API_WRITE_TIMEOUT_MS', 30000),
  /** Upper bound on cached list pages across all merchants; the oldest go first. */
  paymentListCacheMaxEntries: positiveIntFromEnv('PAYMENT_LIST_CACHE_MAX_ENTRIES', 1000),
};
