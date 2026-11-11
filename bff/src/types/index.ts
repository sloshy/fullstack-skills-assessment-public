import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  apiKey?: string; // set by requireApiKey
  /** Set by getMerchant once the key has been resolved, for the request log. */
  merchantId?: string;
}

export interface Merchant {
  id: string;
  name: string;
  currency: string;
  surchargeRate: number; // percent, 3 = 3%
}

/**
 * POST /v1/quotes 200 response, docs/quote-contract.md. The service may add fields; the BFF
 * passes those through untouched (a spread), so this lists only what it checks.
 */
export interface SurchargeServiceQuote {
  merchantId: string;
  currency: string;
  /** VISA | MASTERCARD | AMEX | DISCOVER | UNKNOWN, not checked by the BFF. */
  network: string;
  /** CREDIT | DEBIT | PREPAID | UNKNOWN, not checked by the BFF. */
  cardType: string;
  surchargeable: boolean;
  rate: number;
  amount: number;
  surcharge: number;
  total: number;
  currencyExponent: number;
  amountMinor: number;
  surchargeMinor: number;
  totalMinor: number;
  /** `null` when surcharged. */
  reason: string | null;
  bin: string;
  keyId: string;
  /** Epoch seconds. */
  expiresAt: number;
  signature: string;
}

/** What the terminal gets back from /surcharge/quote: the service's quote minus merchantId. */
export type SurchargeQuote = Omit<SurchargeServiceQuote, 'merchantId'>;

/** Set by the BFF when it can't get a quote (DECISIONS.md 008). */
export type FallbackReason = 'TIMEOUT' | 'UNAVAILABLE' | 'UNKNOWN_MERCHANT';

/** The "no surcharge" quote the BFF sends when it can't get one. It has no keyId, expiresAt or signature. */
// "No surcharge" needs no signature (DECISIONS.md 009).
export type FallbackSurchargeQuote = Omit<SurchargeQuote, 'keyId' | 'expiresAt' | 'signature' | 'reason'> & {
  reason: FallbackReason;
};

export class UpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}
