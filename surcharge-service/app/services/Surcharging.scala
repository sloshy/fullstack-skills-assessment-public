package services

import models.{CardInfo, CardType, MerchantConfig, QuoteReason}

import java.math.{BigDecimal => JBigDecimal, RoundingMode}

object SurchargeRules {

  // a merchant's rate as an exact decimal.  BigDecimal(d) goes through Double.toString, so 2.5 is
  // exactly 2.5 (never new java.math.BigDecimal(double), which gives the binary expansion)
  def rate(merchant: MerchantConfig): BigDecimal = BigDecimal(merchant.surchargeRate)

  // why a card can't be surcharged, or None when it can.  The first that applies wins
  // (docs/surcharging.md rules 6, 2 and 1; docs/quote-contract.md "Reason codes")
  def reason(merchant: MerchantConfig, card: CardInfo): Option[QuoteReason] = {
    if (!merchant.surchargeEnabled || rate(merchant) <= 0) Some(QuoteReason.MerchantOptedOut)
    else card.cardType match {
      case CardType.Credit => None
      case CardType.Unknown => Some(QuoteReason.UnknownBin)
      case CardType.Debit | CardType.Prepaid => Some(QuoteReason.NotCredit)
    }
  }
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
