import { Response } from 'express';
import { logEvent } from '../logger';
import { getMerchant } from '../services/merchantService';
import { currencyExponent, isSafeTotal, toMinorUnits } from '../services/money';
import { fetchQuote } from '../services/surchargeServiceClient';
import { AuthenticatedRequest, FallbackReason, FallbackSurchargeQuote, Merchant, UpstreamError } from '../types';

const BIN_PATTERN = /^\d{8}$/;

// Without the merchant there's no currency to fall back with, so this can't fall back:
// a bad key stays 401 and every other failure is 502 upstream_error.
async function merchantForQuote(req: AuthenticatedRequest): Promise<Merchant> {
  try {
    return await getMerchant(req);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) throw err;
    throw new UpstreamError(502, 'upstream_error');
  }
}

// Preview for the terminal (docs/quote-contract.md). The terminal sends the quote back with the
// payment, so the signed fields must arrive intact. A surcharge problem never blocks a payment
// (DECISIONS.md 008): if the service can't quote, the answer is an explicit "no surcharge".
export async function quoteSurcharge(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { amount, bin } = req.body ?? {};
  // JSON.parse turns 1e999 into Infinity, so finiteness needs checking too
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(amount > 0) || typeof bin !== 'string' || !BIN_PATTERN.test(bin)) {
    res.status(400).json({ error: 'amount must be positive and bin must be 8 digits' });
    return;
  }

  const merchant = await merchantForQuote(req);
  const outcome = await fetchQuote(merchant.id, amount, bin);

  switch (outcome.kind) {
    case 'quote': {
      // A spread, not a whitelist: fields the BFF doesn't know about pass through too
      const { merchantId: _merchantId, ...quote } = outcome.quote;
      res.json(quote);
      return;
    }
    case 'rejected':
      // Status only; the error handler reduces the body to {"error": ...}
      throw new UpstreamError(outcome.status, outcome.error);
    case 'fallback':
      sendFallbackQuote(res, merchant, amount, bin, outcome.reason, outcome.detail);
      return;
  }
}

function sendFallbackQuote(
  res: Response,
  merchant: Merchant,
  amount: number,
  bin: string,
  reason: FallbackReason,
  detail: string,
): void {
  const exponent = currencyExponent(merchant.currency);
  if (exponent === undefined) {
    logEvent('ERROR', 'controllers.surcharge', `Config fault: no currency exponent for ${merchant.currency}`, {
      merchant_id: merchant.id,
    });
    throw new Error(`No currency exponent for ${merchant.currency}`);
  }

  const amountMinor = toMinorUnits(amount, exponent);
  // The fallback's surcharge is 0, so totalMinor is amountMinor; checked anyway
  if (amountMinor === undefined || !isSafeTotal(amountMinor, 0)) {
    res.status(422).json({ error: 'invalid_amount' });
    return;
  }
  const exactAmount = amountMinor / 10 ** exponent;

  const fallback: FallbackSurchargeQuote = {
    currency: merchant.currency,
    network: 'UNKNOWN',
    cardType: 'UNKNOWN',
    surchargeable: false,
    rate: 0,
    amount: exactAmount,
    surcharge: 0,
    total: exactAmount,
    currencyExponent: exponent,
    amountMinor,
    surchargeMinor: 0,
    totalMinor: amountMinor,
    reason,
    bin,
  };

  // Counted and logged only when a fallback quote is actually sent, not for the 422/500 above.
  // UNKNOWN_MERCHANT is a config fault and alerted at higher priority.
  res.locals.surchargeFallback = reason;
  logEvent(reason === 'UNKNOWN_MERCHANT' ? 'ERROR' : 'WARN', 'controllers.surcharge', `Surcharge quote fallback: ${detail}`, {
    merchant_id: merchant.id,
    surcharge_fallback: reason,
  });
  res.json(fallback);
}
