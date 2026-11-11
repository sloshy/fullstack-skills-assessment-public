import { describe, expect, test } from 'vitest'
import { ApiError, WriteOutcomeUnknownError } from '../api/client'
import { classifyWriteError } from './writeErrors'

describe('classifyWriteError', () => {
  test('an unknown outcome gets the check-the-list warning', () => {
    expect(classifyWriteError(new ApiError(504, 'payment_outcome_unknown', 'payment_outcome_unknown'))).toEqual({ kind: 'unknown' })
    expect(classifyWriteError(new WriteOutcomeUnknownError(new TypeError('Failed to fetch')))).toEqual({ kind: 'unknown' })
  })

  test('a 409 quote_invalid re-quotes', () => {
    expect(classifyWriteError(new ApiError(409, 'quote_invalid', 'quote_invalid'))).toMatchObject({ kind: 'requote' })
  })

  test('anything else is a plain failure with its message', () => {
    expect(classifyWriteError(new ApiError(502, 'upstream_error', 'upstream_error'))).toEqual({ kind: 'failed', message: 'upstream_error' })
    expect(classifyWriteError(new ApiError(409, 'already_refunded', 'already_refunded'))).toEqual({ kind: 'failed', message: 'already_refunded' })
    expect(classifyWriteError('nope')).toEqual({ kind: 'failed', message: 'Something went wrong.' })
  })
})
