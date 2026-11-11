import { request, write } from './client'

export type PaymentStatus = 'APPROVED' | 'DECLINED' | 'REFUNDED'

export type Payment = {
  id: string
  amount: number
  surcharge: number
  total: number
  currency: string
  status: PaymentStatus
  declineReason: string | null
  card: {
    network: string
    type: string
    last4: string
  }
  customerName: string | null
  gateway: {
    reference: string | null
    capturedAmountMinor: number
  }
  refundedAmount: number
  createdAt: string
}

export type Page<T> = {
  items: T[]
  page: number
  pageSize: number
  totalCount: number
}

export type NewPayment = {
  amount: number
  cardNumber: string
  expiryMonth: number
  expiryYear: number
  cvv: string
  customerName?: string
  /** The quote shown to the customer, sent back exactly as it was received. */
  quote: SurchargeQuote
}

/** Why a quote has no surcharge (docs/quote-contract.md, "Reason codes"). */
export type SurchargeReason =
  | 'MERCHANT_OPTED_OUT'
  | 'UNKNOWN_BIN'
  | 'NOT_CREDIT'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'UNKNOWN_MERCHANT'

/**
 * The BFF's `/api/surcharge/quote` response (docs/quote-contract.md). A fallback quote
 * (reason TIMEOUT, UNAVAILABLE or UNKNOWN_MERCHANT) has no `keyId`, `expiresAt` or `signature`.
 */
export type SurchargeQuote = {
  currency: string
  network: string
  cardType: string
  surchargeable: boolean
  /** Percent, 0 when not surchargeable. */
  rate: number
  amount: number
  surcharge: number
  total: number
  currencyExponent: number
  amountMinor: number
  surchargeMinor: number
  totalMinor: number
  /** `null` when surcharged. */
  reason: SurchargeReason | null
  /** The 8 digits that were looked up. */
  bin: string
  keyId?: string
  /** Epoch seconds. */
  expiresAt?: number
  signature?: string
}

export const listPayments = (page: number, pageSize: number) =>
  request<Page<Payment>>(`/payments?page=${page}&pageSize=${pageSize}`)

export const getPayment = (id: string) => request<Payment>(`/payments/${encodeURIComponent(id)}`)

export const createPayment = (payment: NewPayment) =>
  write<Payment>('/payments', payment)

export const refundPayment = (id: string) =>
  write<Payment>(`/payments/${encodeURIComponent(id)}/refund`)

/** Client timeout for a quote. */
// The BFF's worst case is getMerchant (3 s) plus the surcharge quote (1.5 s)
export const QUOTE_TIMEOUT_MS = 6000

export const quoteSurcharge = (amount: number, bin: string, signal?: AbortSignal) =>
  request<SurchargeQuote>('/surcharge/quote', { method: 'POST', body: { amount, bin }, timeoutMs: QUOTE_TIMEOUT_MS, signal })
