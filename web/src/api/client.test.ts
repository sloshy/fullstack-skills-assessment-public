import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ApiError,
  isOutcomeUnknown,
  READ_RETRIES,
  READ_TIMEOUT_MS,
  request,
  write,
  WRITE_TIMEOUT_MS,
  WriteOutcomeUnknownError,
} from './client'
import { createPayment, refundPayment } from './payments'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch that never answers, and rejects like the real one when its signal aborts. */
const hangingFetch = () => vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
}))

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('reads', () => {
  test('are retried on a 5xx', async () => {
    fetchMock
      .mockResolvedValueOnce(json(502, { error: 'upstream_error' }))
      .mockResolvedValueOnce(json(200, { ok: true }))

    await expect(request('/payments')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('give up after the retries', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(503, { error: 'unavailable' })))

    await expect(request('/payments')).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1 + READ_RETRIES)
  })

  test('are not retried on a 4xx', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { error: 'not_found' }))

    await expect(request('/payments/x')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('time out after the read timeout', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(hangingFetch())

    const result = request('/payments', { retries: 0 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    expect(await result).toMatchObject({ name: 'AbortError' })
  })
})

describe('writes', () => {
  test('wait longer than reads, and longer than the BFF write timeout of 30 s', () => {
    expect(WRITE_TIMEOUT_MS).toBeGreaterThan(READ_TIMEOUT_MS)
    expect(WRITE_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  test('createPayment is not retried on a 5xx', async () => {
    fetchMock.mockResolvedValue(json(502, { error: 'upstream_error' }))

    await expect(createPayment({} as never)).rejects.toMatchObject({ status: 502, code: 'upstream_error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
  })

  test('refundPayment is not retried on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const error = await refundPayment('pay_1').catch(e => e)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isOutcomeUnknown(error)).toBe(true)
  })

  test('are still waiting after the read timeout, and give up at the write timeout', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(hangingFetch())

    let settled: unknown
    const result = write('/payments', {}).catch(e => { settled = e })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 2)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS)
    await result
    expect(settled).toBeInstanceOf(WriteOutcomeUnknownError)
    expect(isOutcomeUnknown(settled)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('504 payment_outcome_unknown is recognisable', async () => {
    fetchMock.mockResolvedValue(json(504, { error: 'payment_outcome_unknown' }))

    const error = await createPayment({} as never).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 504, code: 'payment_outcome_unknown' })
    expect(isOutcomeUnknown(error)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('any 5xx on a write is an unknown outcome', async () => {
    for (const status of [500, 502, 503, 504]) {
      fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status }))
      expect(isOutcomeUnknown(await createPayment({} as never).catch(e => e))).toBe(true)
    }
    fetchMock.mockResolvedValueOnce(json(500, { error: 'Internal server error' }))
    expect(isOutcomeUnknown(await createPayment({} as never).catch(e => e))).toBe(true)
  })

  test("the BFF's coded 502 upstream_error is a plain failure: the write was never sent", async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: 'upstream_error' }))
    const error = await createPayment({} as never).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, code: 'upstream_error' })
    expect(isOutcomeUnknown(error)).toBe(false)
  })

  test('a 4xx on a write is a plain failure', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: 'quote_invalid' }))
    const error = await createPayment({} as never).catch(e => e)
    expect(error).toMatchObject({ status: 409, code: 'quote_invalid' })
    expect(isOutcomeUnknown(error)).toBe(false)
  })

  test('a 2xx with an unreadable body is an unknown outcome', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 201 }))
    expect(isOutcomeUnknown(await createPayment({} as never).catch(e => e))).toBe(true)
  })

  test('other errors are not an unknown outcome', () => {
    expect(isOutcomeUnknown(new ApiError(504, 'Gateway Timeout'))).toBe(false)
    expect(isOutcomeUnknown(new ApiError(502, 'upstream_error', 'upstream_error'))).toBe(false)
    expect(isOutcomeUnknown(new ApiError(402, 'declined', 'payment_outcome_unknown'))).toBe(false)
  })
})
