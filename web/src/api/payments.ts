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
}

export type SurchargeQuote = {
  network: string
  cardType: string
  surchargeable: boolean
  rate: number
  amount: number
  surcharge: number
  total: number
}

export const listPayments = (page: number, pageSize: number) =>
  request<Page<Payment>>(`/payments?page=${page}&pageSize=${pageSize}`)

export const getPayment = (id: string) => request<Payment>(`/payments/${encodeURIComponent(id)}`)

export const createPayment = (payment: NewPayment) =>
  write<Payment>('/payments', payment)

export const refundPayment = (id: string) =>
  write<Payment>(`/payments/${encodeURIComponent(id)}/refund`)

export const quoteSurcharge = (amount: number, bin: string) =>
  request<SurchargeQuote>('/surcharge/quote', { method: 'POST', body: { amount, bin } })
