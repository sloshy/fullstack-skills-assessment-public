import { ApiError, errorMessage, isOutcomeUnknown } from '../api/client'

/** The error code of a 409 from POST /payments when the quote fails verification. */
export const QUOTE_INVALID = 'quote_invalid'

/** What the terminal does about a failed payment write. */
export type WriteFailure =
  | { kind: 'unknown' }
  | { kind: 'requote', message: string }
  | { kind: 'failed', message: string }

/** Classifies the error from creating a payment or refunding one. */
export const classifyWriteError = (e: unknown): WriteFailure => {
  // DECISIONS.md 016: the operator checks first, which a retry would skip
  if (isOutcomeUnknown(e)) return { kind: 'unknown' }
  // docs/quote-contract.md: re-quote and show the new figures, never re-price silently
  if (e instanceof ApiError && e.status === 409 && e.code === QUOTE_INVALID) {
    return { kind: 'requote', message: 'The surcharge has changed. Check the new total, then charge again.' }
  }
  return { kind: 'failed', message: errorMessage(e) }
}
