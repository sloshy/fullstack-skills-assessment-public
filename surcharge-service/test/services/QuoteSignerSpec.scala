package services

import org.scalatestplus.play.PlaySpec
import play.api.Configuration

class QuoteSignerSpec extends PlaySpec {

  /** The test vector's key (docs/quote-contract.md). */
  val VectorKey = "test-only-quote-signing-key-0123456789abcdef"
  /** The test vector's canonical string (docs/quote-contract.md). */
  val VectorString = "v1|test-1|mer_002|USD|41111111|VISA|CREDIT|18500|463|18963|1767225600"
  /** The test vector's signature (docs/quote-contract.md). */
  val VectorSignature = "_eheNpSMYu68PGi9lBWW-VqEwKqvc2MkL8Sijse2LBU"

  val vectorFields = SignedQuoteFields(
    keyId = "test-1", merchantId = "mer_002", currency = "USD", bin = "41111111",
    network = "VISA", cardType = "CREDIT",
    amountMinor = 18500, surchargeMinor = 463, totalMinor = 18963, expiresAt = 1767225600L)

  def signer(key: String = VectorKey, keyId: String = "test-1") =
    new QuoteSigner(Configuration("surcharge.quoteSigning.key" -> key, "surcharge.quoteSigning.keyId" -> keyId))

  "QuoteSigning" should {

    "build the canonical string from the contract" in {
      QuoteSigning.canonical(vectorFields) mustBe VectorString
    }

    "reproduce the contract's test vector" in {
      QuoteSigning.hmac(VectorKey.getBytes("UTF-8"), VectorString) mustBe VectorSignature
      signer().sign(vectorFields) mustBe VectorSignature
    }

    "encode a 32 byte mac as base64url with no padding" in {
      val sig = signer().sign(vectorFields)
      sig must fullyMatch regex "[A-Za-z0-9_-]{43}"
      java.util.Base64.getUrlDecoder.decode(sig).length mustBe 32
    }

    "change the signature when any signed field changes" in {
      val tampered = Seq(
        vectorFields.copy(keyId = "test-2"),
        vectorFields.copy(merchantId = "mer_001"),
        vectorFields.copy(currency = "JPY"),
        vectorFields.copy(bin = "41111112"),
        vectorFields.copy(network = "MASTERCARD"),
        vectorFields.copy(cardType = "DEBIT"),
        vectorFields.copy(amountMinor = 18501),
        vectorFields.copy(surchargeMinor = 464),
        vectorFields.copy(totalMinor = 18964),
        vectorFields.copy(expiresAt = 1767225601L)
      )
      val s = signer()
      tampered.foreach(f => s.sign(f) must not be VectorSignature)
      tampered.map(s.sign).distinct.size mustBe tampered.size
    }

    "change the signature under a different key" in {
      signer(key = VectorKey + "x").sign(vectorFields) must not be VectorSignature
    }

    "refuse fields that could make the canonical string ambiguous" in {
      an[IllegalArgumentException] mustBe thrownBy { QuoteSigning.canonical(vectorFields.copy(merchantId = "mer|002")) }
      an[IllegalArgumentException] mustBe thrownBy { QuoteSigning.canonical(vectorFields.copy(network = "")) }
      an[IllegalArgumentException] mustBe thrownBy { QuoteSigning.canonical(vectorFields.copy(currency = "US D")) }
      an[IllegalArgumentException] mustBe thrownBy { QuoteSigning.canonical(vectorFields.copy(bin = "4111111")) }
      an[IllegalArgumentException] mustBe thrownBy { QuoteSigning.canonical(vectorFields.copy(bin = "411111111")) }
      an[IllegalArgumentException] mustBe thrownBy { QuoteSigning.canonical(vectorFields.copy(surchargeMinor = -1)) }
    }
  }

  "QuoteSigner" should {

    "refuse a key under 32 bytes" in {
      an[IllegalArgumentException] mustBe thrownBy { signer(key = "x" * 31) }
      signer(key = "x" * 32).keyId mustBe "test-1"
    }

    "refuse a key id outside [A-Za-z0-9_-]" in {
      an[IllegalArgumentException] mustBe thrownBy { signer(keyId = "key|1") }
      an[IllegalArgumentException] mustBe thrownBy { signer(keyId = "") }
    }
  }
}
