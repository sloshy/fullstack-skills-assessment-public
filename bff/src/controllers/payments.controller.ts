import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { config } from '../config';
import { fetchFromPaymentsApi, proxyGet, sendUpstreamResponse } from '../services/paymentsApiProxy';
import { ResponseCache } from '../services/responseCache';

// Every terminal loads the list first, and it's the slowest query the payments API has
const paymentListCache = new ResponseCache<unknown>(config.paymentListCacheTtlMs);

export async function fetchPayments(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const cached = paymentListCache.get(req.originalUrl);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const { status, body } = await fetchFromPaymentsApi(req, `/payments${query ? `?${query}` : ''}`);
    if (status === 200) {
      paymentListCache.set(req.originalUrl, body);
    }
    sendUpstreamResponse(res, status, body);
  } catch (err) {
    next(err);
  }
}

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
  const { status, body } = await fetchFromPaymentsApi(req, '/payments', 'POST', req.body);
  paymentListCache.clear();
  sendUpstreamResponse(res, status, body);
}

export async function refundPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  const id = paymentIdOrReject(req, res);
  if (id === undefined) return;
  const { status, body } = await fetchFromPaymentsApi(req, `/payments/${id}/refund`, 'POST', req.body);
  sendUpstreamResponse(res, status, body);
}
