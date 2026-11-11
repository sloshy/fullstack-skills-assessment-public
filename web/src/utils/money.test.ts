import { describe, expect, test } from 'vitest'
import { formatMinorUnits, formatMinorWithExponent, formatMoney, fractionDigits, parseAmount, toMinorUnits, toMinorUnitsWithExponent } from './money'

describe('formatMoney', () => {
  test('formats in the given currency', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50')
  })
})

describe('formatMinorUnits', () => {
  test('cents to dollars', () => {
    expect(formatMinorUnits(10300, 'USD')).toBe('$103.00')
  })

  test('yen have no minor unit', () => {
    expect(formatMinorUnits(1234, 'JPY')).toBe('¥1,234')
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

describe('fractionDigits', () => {
  test('USD has 2, JPY has 0', () => {
    expect(fractionDigits('USD')).toBe(2)
    expect(fractionDigits('JPY')).toBe(0)
  })
})

describe('toMinorUnits', () => {
  test("uses the currency's digits", () => {
    expect(toMinorUnits(132.3, 'USD')).toBe(13230)
    expect(toMinorUnits(4.35, 'USD')).toBe(435)
    expect(toMinorUnits(1234, 'JPY')).toBe(1234)
  })

  test('tells neighbouring cents apart, as the mismatch check needs', () => {
    expect(toMinorUnits(132.29, 'USD')).toBe(13229)
    expect(toMinorUnits(132.3, 'USD')).not.toBe(13229)
  })
})

describe('parseAmount', () => {
  const yen = (text: string) => parseAmount(text, fractionDigits('JPY'), 'JPY')
  const usd = (text: string) => parseAmount(text, fractionDigits('USD'), 'USD')
  const usdFormat = 'Enter an amount with up to 2 decimal places, like 12.34'

  test('JPY takes whole yen', () => {
    expect(yen('1234')).toEqual({ ok: true, amount: 1234 })
  })

  test.each(['5.5', '5.', '5fdfsd'])('JPY refuses %j rather than rounding it', text => {
    expect(yen(text)).toEqual({ ok: false, error: 'Enter whole yen, like 1234' })
  })

  test.each([
    ['5', 5],
    ['5.5', 5.5],
    ['10.00', 10],
    ['  12.34  ', 12.34],
    ['132.3', 132.3],
  ])('USD takes %j as %d', (text, amount) => {
    expect(usd(text)).toEqual({ ok: true, amount })
  })

  test.each(['10.005', '5fdfsd', '1e3', '-5', '+5', '1,234.00', '1.2.3', '5.', '', '   '])(
    'USD refuses %j rather than changing it',
    text => {
      expect(usd(text)).toEqual({ ok: false, error: usdFormat })
    },
  )

  test.each(['0', '0.00'])('USD refuses %j as not above 0', text => {
    expect(usd(text)).toEqual({ ok: false, error: 'Enter an amount above 0' })
  })

  test('refuses an amount whose minor units would pass MAX_SAFE_INTEGER', () => {
    expect(usd('90071992547409.92')).toEqual({ ok: false, error: 'That amount is too large' })
    expect(usd('99999999999999999')).toEqual({ ok: false, error: 'That amount is too large' })
    expect(yen('9007199254740991')).toEqual({ ok: true, amount: Number.MAX_SAFE_INTEGER })
    expect(yen('9007199254740992')).toEqual({ ok: false, error: 'That amount is too large' })
  })

  test('refuses an amount a number would round, even under the cap', () => {
    // 9007199254740991 cents is the cap, but the double nearest 90071992547409.91 is .9
    expect(usd('90071992547409.91')).toEqual({ ok: false, error: 'That amount is too large' })
    expect(usd('90071992547409.99')).toEqual({ ok: false, error: 'That amount is too large' })
    const parsed = usd('90071992547409.90')
    expect(parsed).toEqual({ ok: true, amount: 90071992547409.9 })
    expect(parsed.ok && toMinorUnits(parsed.amount, 'USD')).toBe(9007199254740990)
    expect(usd('9999999999999.99')).toEqual({ ok: true, amount: 9999999999999.99 })
  })

  test('a leading point asks for a 0 before it', () => {
    expect(usd('.5')).toEqual({ ok: false, error: 'Add a 0 before the point, like 0.50' })
    expect(usd(' .50 ')).toEqual({ ok: false, error: 'Add a 0 before the point, like 0.50' })
    expect(yen('.5')).toEqual({ ok: false, error: 'Enter whole yen, like 1234' })
  })

  test('leading zeros are read, not refused', () => {
    expect(usd('007.50')).toEqual({ ok: true, amount: 7.5 })
    expect(usd('000')).toEqual({ ok: false, error: 'Enter an amount above 0' })
  })

  test('the number is exact for the minor-unit maths', () => {
    const parsed = usd('132.3')
    expect(parsed.ok && toMinorUnits(parsed.amount, 'USD')).toBe(13230)
  })

  test('other currencies get messages for their decimal places', () => {
    expect(parseAmount('1.5', 0, 'KRW')).toEqual({ ok: false, error: 'Enter a whole amount, like 1234' })
    expect(parseAmount('1.2345', 3, 'BHD')).toEqual({ ok: false, error: 'Enter an amount with up to 3 decimal places, like 12.345' })
    expect(parseAmount('1.234', 3, 'BHD')).toEqual({ ok: true, amount: 1.234 })
  })
})
