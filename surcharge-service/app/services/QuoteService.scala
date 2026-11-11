package services

import models._

import jakarta.inject._
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class QuoteService @Inject()(merchants: MerchantDirectory, bins: BinTable)(implicit ec: ExecutionContext) {

  // checks run in the order docs/quote-contract.md lists them: amount > 0, bin, merchant, then
  // the amount against the merchant's currency
  def quote(request: QuoteRequest): Future[Either[QuoteError, Quote]] = {
    if (request.amount <= 0) {
      Future.successful(Left(QuoteError.InvalidAmount))
    } else {
      BinTable.normalize(request.bin) match {
        case None => Future.successful(Left(QuoteError.InvalidBin))
        case Some(bin) =>
          merchants.find(request.merchantId).map {
            case None => Left(QuoteError.UnknownMerchant)
            case Some(merchant) => price(merchant, request.amount, bin)
          }
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
            // a lookup that throws fails the future, which is a 500 and never an UNKNOWN_BIN quote
            val card = bins.lookup(bin).getOrElse(CardInfo.Unknown)
            val reason = SurchargeRules.reason(merchant, card)
            val rate = if (reason.isEmpty) SurchargeRules.rate(merchant) else BigDecimal(0)
            totals(amountMinor, rate, reason.isEmpty) match {
              case None => Left(QuoteError.InvalidAmount)
              case Some((surchargeMinor, totalMinor)) =>
                Right(build(merchant, exponent, card, reason, rate, amountMinor, surchargeMinor, totalMinor))
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

  private def build(merchant: MerchantConfig, exponent: Int, card: CardInfo, reason: Option[QuoteReason],
                    rate: BigDecimal,
                    amountMinor: Long, surchargeMinor: Long, totalMinor: Long): Quote = {
    Quote(
      merchantId = merchant.merchantId,
      currency = merchant.currency,
      network = card.network,
      cardType = card.cardType,
      surchargeable = reason.isEmpty,
      rate = rate,
      amount = Money.fromMinor(amountMinor, exponent),
      surcharge = Money.fromMinor(surchargeMinor, exponent),
      total = Money.fromMinor(totalMinor, exponent),
      currencyExponent = exponent,
      amountMinor = amountMinor,
      surchargeMinor = surchargeMinor,
      totalMinor = totalMinor,
      reason = reason
    )
  }
}
