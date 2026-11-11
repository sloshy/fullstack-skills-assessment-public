package models

import play.api.libs.functional.syntax._
import play.api.libs.json._

case class QuoteRequest(merchantId: String, amount: BigDecimal, bin: String)

object QuoteRequest {

  /** Reads `amount` straight from the JSON number into a BigDecimal, never through a Double.
    * Only a JSON number is accepted (play's own BigDecimal reads would also take a string).
    */
  private val AmountReads: Reads[BigDecimal] = Reads {
    case JsNumber(n) => JsSuccess(n)
    case _ => JsError("error.expected.jsnumber")
  }

  implicit val QuoteRequestReads: Reads[QuoteRequest] = (
    (__ \ "merchantId").read[String] and
      (__ \ "amount").read(AmountReads) and
      (__ \ "bin").read[String]
    )(QuoteRequest.apply _)
}

/** Why a quote carries no surcharge (docs/quote-contract.md, "Reason codes"). */
sealed abstract class QuoteReason(val code: String)

object QuoteReason {
  case object MerchantOptedOut extends QuoteReason("MERCHANT_OPTED_OUT")
  case object UnknownBin extends QuoteReason("UNKNOWN_BIN")
  case object NotCredit extends QuoteReason("NOT_CREDIT")

  implicit val QuoteReasonWrites: Writes[QuoteReason] = Writes(r => JsString(r.code))
}

/** A surcharge quote. `amount`, `surcharge` and `total` are exact decimals derived from the
  * minor-unit fields.
  */
case class Quote(merchantId: String,
                 currency: String,
                 network: String,
                 cardType: CardType,
                 surchargeable: Boolean,
                 rate: BigDecimal,
                 amount: BigDecimal,
                 surcharge: BigDecimal,
                 total: BigDecimal,
                 currencyExponent: Int,
                 amountMinor: Long,
                 surchargeMinor: Long,
                 totalMinor: Long,
                 reason: Option[QuoteReason],
                 bin: String,
                 keyId: String,
                 expiresAt: Long,
                 signature: String)

object Quote {
  /** Writes `reason` as null when surcharged, rather than leaving it out. */
  implicit val QuoteWrites: OWrites[Quote] =
    Json.configured(JsonConfiguration(optionHandlers = OptionHandlers.WritesNull)).writes[Quote]
}

sealed trait QuoteError
object QuoteError {
  case object UnknownMerchant extends QuoteError
  case object InvalidAmount extends QuoteError
  case object InvalidBin extends QuoteError
  /** The merchant's currency has no known exponent, a configuration fault. */
  case class UnsupportedCurrency(currency: String) extends QuoteError
}
