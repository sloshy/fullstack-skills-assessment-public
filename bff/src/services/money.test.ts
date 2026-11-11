import { currencyExponent, toMinorUnits } from './money';

describe('currencyExponent', () => {
  it('knows USD and JPY and has no default for anything else', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('EUR')).toBeUndefined();
    expect(currencyExponent('toString')).toBeUndefined();
  });
});

describe('toMinorUnits', () => {
  it.each([
    [185, 2, 18500],
    [1.15, 2, 115],
    [10.0, 2, 1000],
    [100.0, 0, 100],
    [1234, 0, 1234],
    [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
  ])('%p with exponent %p is %p', (amount, exponent, minor) => {
    expect(toMinorUnits(amount, exponent)).toBe(minor);
  });

  it.each([
    [10.001, 2],
    [0.1 + 0.2, 2],
    [100.5, 0],
    [1e14, 2], // 1e16 minor units is past 2^53 - 1
    [2 ** 53, 0],
  ])('rejects %p with exponent %p', (amount, exponent) => {
    expect(toMinorUnits(amount, exponent)).toBeUndefined();
  });
});
