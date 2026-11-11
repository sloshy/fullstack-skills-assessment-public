package services

import models._

import jakarta.inject._
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class QuoteService @Inject()(merchants: MerchantDirectory, bins: BinTable)(implicit ec: ExecutionContext) {

  // amount > 0 is checked before the merchant, the amount against the merchant's currency after
  def quote(request: QuoteRequest): Future[Either[QuoteError, Quote]] = {
    if (request.amount <= 0) {
      Future.successful(Left(QuoteError.InvalidAmount))
    } else {
      merchants.find(request.merchantId).map {
        case None => Left(QuoteError.UnknownMerchant)
        case Some(merchant) => price(merchant, request.amount, request.bin)
      }
    }
  }

  private def price(merchant: MerchantConfig, amount: BigDecimal, bin: String): Either[QuoteError, Quote] = {
    Currency.exponent(merchant.currency) match {
      case None => Left(QuoteError.UnsupportedCurrency(merchant.currency))
      case Some(exponent) =>
        Money.toMinor(amount, exponent) match {
          case None => Left(QuoteError.InvalidAmount)
          case Some(amountMinor) =>
            val card = bins.lookup(bin).getOrElse(CardInfo.Unknown)
            val surchargeable = merchant.surchargeEnabled && SurchargeRules.isSurchargeable(card)
            val rate = if (surchargeable) SurchargeRules.rate(merchant) else BigDecimal(0)
            totals(amountMinor, rate, surchargeable) match {
              case None => Left(QuoteError.InvalidAmount)
              case Some((surchargeMinor, totalMinor)) =>
                Right(build(merchant, exponent, card, surchargeable, rate, amountMinor, surchargeMinor, totalMinor))
            }
        }
    }
  }

  // (surchargeMinor, totalMinor), or None when the total would pass Money.MaxMinor.  Only this
  // arithmetic maps to a 422; an ArithmeticException anywhere else stays a 5xx
  private def totals(amountMinor: Long, rate: BigDecimal, surchargeable: Boolean): Option[(Long, Long)] = {
    try {
      val surchargeMinor = if (surchargeable) SurchargeCalculator.surchargeMinor(amountMinor, rate) else 0L
      val totalMinor = Math.addExact(amountMinor, surchargeMinor)
      if (totalMinor <= Money.MaxMinor) Some((surchargeMinor, totalMinor)) else None
    } catch {
      case _: ArithmeticException => None
    }
  }

  private def build(merchant: MerchantConfig, exponent: Int, card: CardInfo, surchargeable: Boolean,
                    rate: BigDecimal,
                    amountMinor: Long, surchargeMinor: Long, totalMinor: Long): Quote = {
    Quote(
      merchantId = merchant.merchantId,
      currency = merchant.currency,
      network = card.network,
      cardType = card.cardType,
      surchargeable = surchargeable,
      rate = rate,
      amount = Money.fromMinor(amountMinor, exponent),
      surcharge = Money.fromMinor(surchargeMinor, exponent),
      total = Money.fromMinor(totalMinor, exponent),
      currencyExponent = exponent,
      amountMinor = amountMinor,
      surchargeMinor = surchargeMinor,
      totalMinor = totalMinor
    )
  }
}
