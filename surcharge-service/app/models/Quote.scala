package models

import play.api.libs.functional.syntax._
import play.api.libs.json._

case class QuoteRequest(merchantId: String, amount: BigDecimal, bin: String)

object QuoteRequest {

  // amount is read straight from the JSON number into a BigDecimal, never through a Double.  Only
  // a JSON number is accepted (play's own BigDecimal reads would also take a string)
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

// amount, surcharge and total are exact decimals derived from the minor-unit fields
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
                 totalMinor: Long)

object Quote {
  implicit val QuoteWrites: OWrites[Quote] = Json.writes[Quote]
}

sealed trait QuoteError
object QuoteError {
  case object UnknownMerchant extends QuoteError
  case object InvalidAmount extends QuoteError
  // the merchant's currency has no known exponent, a configuration fault
  case class UnsupportedCurrency(currency: String) extends QuoteError
}
