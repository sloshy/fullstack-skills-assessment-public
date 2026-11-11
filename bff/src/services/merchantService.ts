import { createHash } from 'node:crypto';
import { AuthenticatedRequest, Merchant, UpstreamError } from '../types';
import { fetchFromPaymentsApi } from './paymentsApiProxy';

/**
 * SHA-256 hex digest of an API key. Cache keys and anything else that outlives the request use
 * this, never the raw key.
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

// Merchant profiles hardly ever change, so each API key only gets looked up once
const merchantCache = new Map<string, Merchant>();

function isMerchant(body: unknown): body is Merchant {
  const m = body as Partial<Merchant> | null;
  return typeof m === 'object' && m !== null && typeof m.id === 'string' && typeof m.currency === 'string';
}

/**
 * The merchant behind the request's API key, looked up once per key. Also sets
 * `req.merchantId`.
 *
 * @throws UpstreamError with the payments API's status for an HTTP error (401 for a bad key),
 * or UpstreamError(502) for a network error, timeout or unreadable body.
 */
export async function getMerchant(req: AuthenticatedRequest): Promise<Merchant> {
  const keyHash = hashApiKey(req.apiKey ?? '');
  const cached = merchantCache.get(keyHash);
  if (cached) {
    req.merchantId = cached.id;
    return cached;
  }

  const { status, body } = await fetchFromPaymentsApi(req, '/merchants/me');
  if (status !== 200) {
    const error = (body as { error?: unknown } | undefined)?.error;
    const message = typeof error === 'string' ? error : 'Merchant lookup failed';
    throw new UpstreamError(status, message);
  }
  if (!isMerchant(body)) {
    throw new UpstreamError(502, 'upstream_error');
  }

  merchantCache.set(keyHash, body);
  req.merchantId = body.id;
  return body;
}
