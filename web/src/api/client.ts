import { getApiKey } from './session'

/** Client timeout for reads, which are safe to retry. */
export const READ_TIMEOUT_MS = 4000
/** Automatic retries for reads on a timeout, network error or 5xx. */
export const READ_RETRIES = 2
/** Client timeout for payment writes (create, refund). */
// Above the BFF's 30 s write timeout (DECISIONS.md 014), so the BFF's 504 normally arrives first
export const WRITE_TIMEOUT_MS = 35_000

/** The error code the BFF sends with a 504 when a write may or may not have happened. */
export const PAYMENT_OUTCOME_UNKNOWN = 'payment_outcome_unknown'
/** The error code of the BFF's 502 for a write it couldn't have sent (DECISIONS.md 014). */
export const UPSTREAM_ERROR = 'upstream_error'

/** A non-2xx response; `code` is the body's `error` field when it has one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

/** A write that failed in the browser after it may have been sent (timeout or lost connection). */
export class WriteOutcomeUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super("The request didn't finish, so the outcome is unknown.")
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  timeoutMs?: number
  retries?: number
  /** Cancels the request, including any retries. */
  signal?: AbortSignal
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

const isTransient = (e: unknown) =>
  isAbort(e) ||
  e instanceof TypeError ||
  (e instanceof ApiError && e.status >= 500)

const readError = async (res: Response) => {
  try {
    const body = await res.json()
    const code = typeof body.error === 'string' ? body.error : undefined
    return { message: body.detail ?? body.title ?? body.error ?? res.statusText, code }
  } catch {
    return { message: res.statusText, code: undefined }
  }
}

export const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const { method = 'GET', body, timeoutMs = READ_TIMEOUT_MS, retries = READ_RETRIES, signal } = options

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel)
    if (signal?.aborted) cancel()

    try {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const { message, code } = await readError(res)
        throw new ApiError(res.status, message, code)
      }
      return await res.json() as T
    } catch (e) {
      // A caller's cancel looks like a timeout, but must not be retried
      if (signal?.aborted || attempt >= retries || !isTransient(e)) throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}

/** A payment write (create or refund): never retried, with the longer write timeout. */
// A retried write can charge twice (DECISIONS.md 014). A browser timeout, a dropped
// connection, a 2xx with an unreadable body, or any 5xx can all come after the write reached
// the payments API, so they're unknown outcomes too. The one 5xx that means "never sent" is
// the BFF's coded 502 upstream_error.
export const write = async <T>(path: string, body?: unknown): Promise<T> => {
  try {
    return await request<T>(path, { method: 'POST', body, timeoutMs: WRITE_TIMEOUT_MS, retries: 0 })
  } catch (e) {
    if (isAbort(e) || e instanceof TypeError || e instanceof SyntaxError) throw new WriteOutcomeUnknownError(e)
    const neverSent = e instanceof ApiError && e.status === 502 && e.code === UPSTREAM_ERROR
    if (e instanceof ApiError && e.status >= 500 && !neverSent && !isOutcomeUnknown(e)) throw new WriteOutcomeUnknownError(e)
    throw e
  }
}

/** Whether a write's error means it may or may not have happened. */
export const isOutcomeUnknown = (e: unknown) =>
  e instanceof WriteOutcomeUnknownError ||
  (e instanceof ApiError && e.status === 504 && e.code === PAYMENT_OUTCOME_UNKNOWN)

export const errorMessage = (e: unknown) => {
  if (isAbort(e)) return 'The request timed out.'
  return e instanceof Error ? e.message : 'Something went wrong.'
}
