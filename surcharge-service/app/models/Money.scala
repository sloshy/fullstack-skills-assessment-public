package models

import java.math.{BigDecimal => JBigDecimal}

object Currency {

  /** ISO 4217 minor-unit exponents, by currency code.
    *
    * There is deliberately no default: a currency missing from here is a configuration error,
    * never "assume 2" (DECISIONS.md 010).
    */
  val Exponents: Map[String, Int] = Map("USD" -> 2, "JPY" -> 0)

  def exponent(code: String): Option[Int] = Exponents.get(code)
}

object Money {

  /** The largest minor-unit value we accept or return: `2^53 - 1`, so JS consumers (BFF, terminal)
    * never see an integer they can't represent exactly.
    */
  val MaxMinor: Long = 9007199254740991L

  /** `amount × 10^exponent` when that is exactly an integer no greater than `MaxMinor`, else None.
    *
    * A value check, not a scale check, so 100.0 JPY is 100 and 10.000 USD is 1000, but 100.5 JPY
    * and 10.001 USD are None.
    */
  def toMinor(amount: BigDecimal, exponent: Int): Option[Long] = {
    // movePointRight is exact, unlike multiplying under scala's default MathContext
    try Some(amount.bigDecimal.movePointRight(exponent).longValueExact()).filter(_ <= MaxMinor)
    catch { case _: ArithmeticException => None }
  }

  /** Minor units back to a decimal amount with exactly `exponent` decimal places. */
  def fromMinor(minor: Long, exponent: Int): BigDecimal = BigDecimal(JBigDecimal.valueOf(minor, exponent))
}
