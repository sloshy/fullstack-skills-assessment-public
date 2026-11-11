package services

import play.api.Configuration

import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import jakarta.inject._

/** The fields a quote signature covers, in canonical-string order (docs/quote-contract.md, "Signature"). */
case class SignedQuoteFields(keyId: String,
                             merchantId: String,
                             currency: String,
                             bin: String,
                             network: String,
                             cardType: String,
                             amountMinor: Long,
                             surchargeMinor: Long,
                             totalMinor: Long,
                             expiresAt: Long)

object QuoteSigning {

  val Version = "v1"
  val Algorithm = "HmacSHA256"
  val MinKeyBytes = 32
  /** How long a quote stays valid after it's issued, in seconds. */
  val TtlSeconds = 300L

  private val Token = "[A-Za-z0-9_-]+".r
  private val Bin = "[0-9]{8}".r

  /** Whether a value can be signed as a merchant id, currency, key id, network or card type. */
  def isToken(value: String): Boolean = Token.matches(value)

  /** The canonical string a signature covers:
    * `v1|{keyId}|{merchantId}|{currency}|{bin}|{network}|{cardType}|{amountMinor}|{surchargeMinor}|{totalMinor}|{expiresAt}`.
    *
    * Fields are checked so that no value can contain the separator or be read two ways.
    */
  def canonical(f: SignedQuoteFields): String = {
    def token(name: String, value: String): String = {
      require(isToken(value), s"$name is not [A-Za-z0-9_-]+")
      value
    }
    def number(name: String, value: Long): String = {
      require(value >= 0, s"$name is negative")
      value.toString
    }
    require(Bin.matches(f.bin), "bin is not exactly 8 digits")

    Seq(
      Version,
      token("keyId", f.keyId),
      token("merchantId", f.merchantId),
      token("currency", f.currency),
      f.bin,
      token("network", f.network),
      token("cardType", f.cardType),
      number("amountMinor", f.amountMinor),
      number("surchargeMinor", f.surchargeMinor),
      number("totalMinor", f.totalMinor),
      number("expiresAt", f.expiresAt)
    ).mkString("|")
  }

  /** HMAC-SHA256 over the UTF-8 bytes of `message`, base64url without padding. */
  def hmac(key: Array[Byte], message: String): String = {
    val mac = Mac.getInstance(Algorithm)
    mac.init(new SecretKeySpec(key, Algorithm))
    Base64.getUrlEncoder.withoutPadding.encodeToString(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)))
  }
}

/** Signs quotes with the key from `surcharge.quoteSigning` (`QUOTE_SIGNING_KEY` / `QUOTE_SIGNING_KEY_ID`).
  *
  * Bound as an eager singleton so a bad key stops the service at startup, not on the first quote.
  */
@Singleton
class QuoteSigner @Inject()(config: Configuration) extends com.typesafe.scalalogging.LazyLogging {

  private val keyString = config.get[String]("surcharge.quoteSigning.key")
  private val key = keyString.getBytes(StandardCharsets.UTF_8)

  val keyId: String = config.get[String]("surcharge.quoteSigning.keyId")

  require(key.length >= QuoteSigning.MinKeyBytes,
    s"surcharge.quoteSigning.key must be at least ${QuoteSigning.MinKeyBytes} bytes, it is ${key.length}")
  require(QuoteSigning.isToken(keyId), "surcharge.quoteSigning.keyId must be [A-Za-z0-9_-]+")

  private val usingDevKey = config.getOptional[String]("surcharge.quoteSigning.devDefaultKey").contains(keyString)
  private val usingDevKeyId = config.getOptional[String]("surcharge.quoteSigning.devDefaultKeyId").contains(keyId)

  if (usingDevKey) {
    logger.warn(s"quote signing is using the development default key (keyId $keyId). " +
      "Set QUOTE_SIGNING_KEY and QUOTE_SIGNING_KEY_ID to a real key shared with the payments api.")
  } else if (usingDevKeyId) {
    // a real key under the dev key id makes rotation and verifier key selection ambiguous
    logger.warn(s"quote signing has a real key but still the development default key id ($keyId). " +
      "Set QUOTE_SIGNING_KEY_ID as well.")
  }

  /** The signature for a quote's fields.
    *
    * @throws IllegalArgumentException if a field can't be signed unambiguously
    */
  def sign(fields: SignedQuoteFields): String = QuoteSigning.hmac(key, QuoteSigning.canonical(fields))
}
