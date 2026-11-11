import { config } from '../config';
import { describeError } from '../logger';
import { FallbackReason, SurchargeServiceQuote } from '../types';

// docs/quote-contract.md, "POST /api/surcharge/quote". Never throws: every outcome is one of these.
export type QuoteOutcome =
  // A 2xx with a body that passed the required-field check. Unknown fields are kept.
  | { kind: 'quote'; quote: SurchargeServiceQuote & Record<string, unknown> }
  // 400 or 422: passed through with the status only
  | { kind: 'rejected'; status: 400 | 422; error: string }
  // Anything else: the BFF falls back to "no surcharge"
  | { kind: 'fallback'; reason: FallbackReason; detail: string };

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'string|null';

// Every field in the contract's response table, with its JSON type. Enum values aren't checked.
const REQUIRED_FIELDS: Record<keyof SurchargeServiceQuote, JsonType> = {
  merchantId: 'string',
  currency: 'string',
  network: 'string',
  cardType: 'string',
  surchargeable: 'boolean',
  rate: 'number',
  amount: 'number',
  surcharge: 'number',
  total: 'number',
  currencyExponent: 'integer',
  amountMinor: 'integer',
  surchargeMinor: 'integer',
  totalMinor: 'integer',
  reason: 'string|null',
  bin: 'string',
  keyId: 'string',
  expiresAt: 'integer',
  signature: 'string',
};

function hasType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      // The contract caps the minor-unit fields at 2^53 - 1
      return Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string|null':
      return value === null || typeof value === 'string';
  }
}

// Returns the first field that is missing or has the wrong type, or undefined if the body is complete
export function findInvalidQuoteField(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return '(body is not an object)';
  const record = body as Record<string, unknown>;
  for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in record) || !hasType(record[field], type)) return field;
  }
  return undefined;
}

// AbortSignal.timeout rejects fetch with a DOMException named TimeoutError. Checked by name,
// not instanceof, because DOMException isn't guaranteed to share our realm's Error.
function isTimeout(err: unknown): boolean {
  const e = err as { name?: unknown; cause?: { name?: unknown } } | null;
  return e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
}

export async function fetchQuote(merchantId: string, amount: number, bin: string): Promise<QuoteOutcome> {
  let status: number;
  let text: string;
  try {
    // The timeout covers reading the body too
    const response = await fetch(new URL('/v1/quotes', config.surchargeServiceUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId, amount, bin }),
      signal: AbortSignal.timeout(config.surchargeQuoteTimeoutMs),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    if (isTimeout(err)) {
      return { kind: 'fallback', reason: 'TIMEOUT', detail: `no response within ${config.surchargeQuoteTimeoutMs}ms` };
    }
    return { kind: 'fallback', reason: 'UNAVAILABLE', detail: describeError(err) };
  }

  let body: unknown;
  let readable = true;
  try {
    body = JSON.parse(text);
  } catch {
    readable = false;
  }

  // Any 404 counts as an unknown merchant, including a routing 404 (accepted in the contract)
  if (status === 404) {
    return { kind: 'fallback', reason: 'UNKNOWN_MERCHANT', detail: 'surcharge service returned 404' };
  }

  if (status === 400 || status === 422) {
    const error = (body as { error?: unknown } | undefined)?.error;
    return {
      kind: 'rejected',
      status,
      error: typeof error === 'string' ? error : status === 400 ? 'invalid_request' : 'invalid_amount',
    };
  }

  if (status < 200 || status >= 300) {
    return { kind: 'fallback', reason: 'UNAVAILABLE', detail: `surcharge service returned ${status}` };
  }

  if (!readable) {
    return { kind: 'fallback', reason: 'UNAVAILABLE', detail: `status ${status} with a body that isn't JSON` };
  }

  const invalidField = findInvalidQuoteField(body);
  if (invalidField !== undefined) {
    return { kind: 'fallback', reason: 'UNAVAILABLE', detail: `incomplete quote: ${invalidField} missing or wrong type` };
  }

  return { kind: 'quote', quote: body as SurchargeServiceQuote & Record<string, unknown> };
}
