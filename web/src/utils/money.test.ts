import { describe, expect, test } from 'vitest'
import { formatMinorUnits, formatMinorWithExponent, formatMoney, toMinorUnitsWithExponent } from './money'

describe('formatMoney', () => {
  test('formats in the given currency', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50')
  })
})

describe('formatMinorUnits', () => {
  test('cents to dollars', () => {
    expect(formatMinorUnits(10300, 'USD')).toBe('$103.00')
  })
})

describe('formatMinorWithExponent', () => {
  test('uses the exponent it is given', () => {
    expect(formatMinorWithExponent(18963, 2, 'USD')).toBe('$189.63')
    expect(formatMinorWithExponent(1234, 0, 'JPY')).toBe('¥1,234')
  })
})

describe('toMinorUnitsWithExponent', () => {
  test('is exact where multiplying would not be', () => {
    expect(toMinorUnitsWithExponent(132.3, 2)).toBe(13230)
    expect(toMinorUnitsWithExponent(4.35, 2)).toBe(435)
    expect(toMinorUnitsWithExponent(1.005, 2)).toBe(101)
  })

  test('zero and negative amounts', () => {
    expect(toMinorUnitsWithExponent(0, 2)).toBe(0)
    expect(toMinorUnitsWithExponent(-4.35, 2)).toBe(-435)
  })

  test('exponent notation falls back to multiplying', () => {
    expect(toMinorUnitsWithExponent(1e21, 2)).toBe(1e23)
    expect(toMinorUnitsWithExponent(1e-7, 2)).toBe(0)
  })
})
