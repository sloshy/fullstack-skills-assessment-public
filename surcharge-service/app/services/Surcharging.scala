package services

import models.{CardInfo, CardType, MerchantConfig}

import java.math.{BigDecimal => JBigDecimal, RoundingMode}

object SurchargeRules {

  // the card networks don't allow surcharging debit cards (docs/surcharging.md)
  def isSurchargeable(card: CardInfo): Boolean = card.cardType != CardType.Debit

  // a merchant's rate as an exact decimal.  BigDecimal(d) goes through Double.toString, so 2.5 is
  // exactly 2.5 (never new java.math.BigDecimal(double), which gives the binary expansion)
  def rate(merchant: MerchantConfig): BigDecimal = BigDecimal(merchant.surchargeRate)
}

object SurchargeCalculator {

  // amountMinor × ratePercent / 100, rounded half up to a whole minor unit (rule 3).  Every step
  // is exact java BigDecimal arithmetic, with no MathContext rounding along the way
  def surchargeMinor(amountMinor: Long, ratePercent: BigDecimal): Long = {
    JBigDecimal.valueOf(amountMinor)
      .multiply(ratePercent.bigDecimal)
      .movePointLeft(2)
      .setScale(0, RoundingMode.HALF_UP)
      .longValueExact()
  }
}
