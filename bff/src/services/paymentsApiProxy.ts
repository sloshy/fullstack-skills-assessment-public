import { Response } from 'express';
import { config } from '../config';
import { describeError, logEvent } from '../logger';
import { AuthenticatedRequest, UpstreamError } from '../types';

function forwardedHeaders(req: AuthenticatedRequest): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': req.apiKey ?? '',
  };
}

// The payments API may have charged the card (it doesn't cancel when we give up), so the
// client must check the payments list rather than retry
export const PAYMENT_OUTCOME_UNKNOWN = 'payment_outcome_unknown';

// Failures where the request can't have reached the payments API: the error codes, and only
// while resolving or connecting. ENETUNREACH/EHOSTUNREACH on an established socket (syscall
// read/write) may come after the request went out, so those don't count.
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);
const NOT_SENT_SYSCALLS = new Set(['connect', 'getaddrinfo']);

interface SystemErrorLike {
  code?: unknown;
  syscall?: unknown;
  errors?: unknown;
}

function isPreSendError(e: SystemErrorLike): boolean {
  return (
    typeof e.code === 'string' && NOT_SENT_CODES.has(e.code) && typeof e.syscall === 'string' && NOT_SENT_SYSCALLS.has(e.syscall)
  );
}

// fetch puts the system error in `cause`. With several addresses (happy eyeballs) the cause is
// an AggregateError of one error per attempt; then every attempt must have failed before sending.
function wasNeverSent(err: unknown): boolean {
  const cause = (err as { cause?: SystemErrorLike } | null)?.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const attempts = Array.isArray(cause.errors) && cause.errors.length > 0 ? (cause.errors as SystemErrorLike[]) : [cause];
  return attempts.every((attempt) => typeof attempt === 'object' && attempt !== null && isPreSendError(attempt));
}

// A gateway or load balancer answering for the payments API (its own HTML page): the request
// may have reached the payments API before the gateway gave up
const GATEWAY_STATUSES = new Set([502, 503, 504]);

function failure(method: string, path: string, problem: string, outcomeUnknown: boolean): UpstreamError {
  // path is ours (ids and query only); the API key is a header and never logged
  logEvent('ERROR', 'services.paymentsApiProxy', `Payments API request failed: ${problem}`, {
    method,
    path,
    ...(outcomeUnknown ? { event: PAYMENT_OUTCOME_UNKNOWN } : {}),
  });
  return outcomeUnknown ? new UpstreamError(504, PAYMENT_OUTCOME_UNKNOWN) : new UpstreamError(502, 'upstream_error');
}

// For callers that need the body rather than piping it to res. path is relative to /api.
// GET is a read (PAYMENTS_API_TIMEOUT_MS); anything else is a non-idempotent write
// (PAYMENTS_API_WRITE_TIMEOUT_MS). Any HTTP status is returned to the caller as is. Otherwise:
// - a read that fails (network, timeout, body that isn't JSON) throws UpstreamError(502);
// - a write that fails after it may have reached the payments API (a timeout, a dropped
//   connection, a 2xx we can't read, or a gateway's non-JSON 502/503/504 page) throws
//   UpstreamError(504, payment_outcome_unknown); one that can't have been sent (DNS failure,
//   connection refused while connecting) or another non-JSON error status is 502.
export async function fetchFromPaymentsApi(
  req: AuthenticatedRequest,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const isWrite = method !== 'GET';
  let status: number;
  let text: string;
  try {
    const response = await fetch(new URL(`/api${path}`, config.paymentsApiUrl), {
      method,
      headers: forwardedHeaders(req),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(isWrite ? config.paymentsApiWriteTimeoutMs : config.paymentsApiTimeoutMs),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    throw failure(method, path, describeError(err), isWrite && !wasNeverSent(err));
  }

  if (!text) return { status, body: undefined };
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    const succeeded = status >= 200 && status < 300;
    const outcomeUnknown = isWrite && (succeeded || GATEWAY_STATUSES.has(status));
    throw failure(method, path, `status ${status} with a body that isn't JSON`, outcomeUnknown);
  }
}

export function sendUpstreamResponse(res: Response, status: number, body: unknown): void {
  if (body === undefined) {
    res.status(status).end();
  } else {
    res.status(status).json(body);
  }
}

export async function proxyGet(req: AuthenticatedRequest, res: Response, path: string): Promise<void> {
  const { status, body } = await fetchFromPaymentsApi(req, path);
  sendUpstreamResponse(res, status, body);
}
