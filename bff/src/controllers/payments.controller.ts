import { Response } from 'express';
import { AuthenticatedRequest, UpstreamError } from '../types';
import { config } from '../config';
import { describeError, logEvent } from '../logger';
import { getMerchant, hashApiKey } from '../services/merchantService';
import {
  fetchFromPaymentsApi,
  PAYMENT_OUTCOME_UNKNOWN,
  proxyGet,
  sendUpstreamResponse,
} from '../services/paymentsApiProxy';
import { ResponseCache } from '../services/responseCache';

/**
 * Cache of payment list pages. Entries are grouped by merchant so a create or refund can drop
 * just that merchant's pages.
 */
// Every terminal loads the list first, and it's the slowest query the payments API has.
const paymentListCache = new ResponseCache<unknown>(config.paymentListCacheTtlMs, config.paymentListCacheMaxEntries);

/** The only parameters the payments API's list takes (PaymentsController.List). */
const LIST_PARAMS = ['page', 'pageSize'] as const;

/**
 * The allow-listed parameters from the raw URL, in a fixed order and first value only, so
 * ?pageSize=10&page=2 and ?page=2&pageSize=10 share an entry and junk parameters can't mint
 * new keys. The same string goes upstream, so the key always matches what was fetched.
 */
function normalisedQuery(req: AuthenticatedRequest): string {
  const queryStart = req.originalUrl.indexOf('?');
  const raw = new URLSearchParams(queryStart === -1 ? '' : req.originalUrl.slice(queryStart + 1));
  const params = new URLSearchParams();
  for (const name of LIST_PARAMS) {
    const value = raw.get(name);
    if (value !== null) params.set(name, value);
  }
  return params.toString();
}

/**
 * The list cache key: the merchant (for invalidation) and a hash of the API key, so an entry is
 * only ever served to the key that filled it. The raw key is never stored.
 */
// INC-4486: the key used to be the URL alone, so every merchant shared one entry per URL.
// A wrong key never reads a cached page: nothing was ever cached under its hash, so its lookup goes
// upstream and gets the 401. A revoked key can still re-read the pages it filled itself until they
// expire, because merchantService caches key → merchant without a TTL (NOTES.md Task 7 #5), but it
// can never read another key's entries.
function listCacheKey(merchantId: string, apiKey: string, query: string): string {
  return JSON.stringify([merchantId, hashApiKey(apiKey), query]);
}

export async function fetchPayments(req: AuthenticatedRequest, res: Response): Promise<void> {
  const merchant = await getMerchant(req);
  const query = normalisedQuery(req);
  const key = listCacheKey(merchant.id, req.apiKey ?? '', query);

  const cached = paymentListCache.get(key);
  if (cached !== undefined) {
    res.locals.cache = 'hit';
    res.json(cached);
    return;
  }

  res.locals.cache = 'miss';
  const generation = paymentListCache.generation(merchant.id);
  const { status, body } = await fetchFromPaymentsApi(req, `/payments${query ? `?${query}` : ''}`);
  if (status === 200 && body !== undefined) {
    paymentListCache.set(key, body, { group: merchant.id, generation });
  }
  sendUpstreamResponse(res, status, body);
}

/**
 * The URL-encoded payment ID from the route, or `undefined` after sending a 400 for "." or "..".
 */
// encodeURIComponent leaves "." and ".." alone, and the URL parser then resolves them as path
// segments: /payments/%2E%2E/refund would reach /api/refund. Reject them before proxying.
function paymentIdOrReject(req: AuthenticatedRequest, res: Response): string | undefined {
  const { id } = req.params;
  if (id === '.' || id === '..') {
    res.status(400).json({ error: 'invalid_payment_id' });
    return undefined;
  }
  return encodeURIComponent(id);
}

export async function fetchPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  const id = paymentIdOrReject(req, res);
  if (id === undefined) return;
  await proxyGet(req, res, `/payments/${id}`);
}

export async function createPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  await postAndInvalidate(req, res, '/payments');
}

export async function refundPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  const id = paymentIdOrReject(req, res);
  if (id === undefined) return;
  await postAndInvalidate(req, res, `/payments/${id}/refund`);
}

/**
 * POSTs to the payments API and drops the merchant's cached list pages if the write succeeded
 * or its outcome is unknown.
 */
// The list changes only when the write succeeded, and then for that merchant only. Invalidate
// before responding so the terminal's next list request sees the change. If the outcome is
// unknown (504 payment_outcome_unknown) the payment may exist, so invalidate then too.
async function postAndInvalidate(req: AuthenticatedRequest, res: Response, path: string): Promise<void> {
  let result: { status: number; body: unknown };
  try {
    result = await fetchFromPaymentsApi(req, path, 'POST', req.body);
  } catch (err) {
    if (err instanceof UpstreamError && err.message === PAYMENT_OUTCOME_UNKNOWN) {
      await invalidateMerchantLists(req);
    }
    throw err;
  }

  const { status, body } = result;
  if (status >= 200 && status < 300) {
    await invalidateMerchantLists(req);
  }
  sendUpstreamResponse(res, status, body);
}

async function invalidateMerchantLists(req: AuthenticatedRequest): Promise<void> {
  try {
    const merchant = await getMerchant(req);
    paymentListCache.deleteGroup(merchant.id);
  } catch (err) {
    // The write went through, so don't fail the response. Without the merchant ID, drop
    // everything: over-invalidating costs a few extra list queries, stale data costs more.
    logEvent('WARN', 'controllers.payments', `Merchant lookup failed after a write, clearing the whole list cache: ${describeError(err)}`);
    paymentListCache.clear();
  }
}
