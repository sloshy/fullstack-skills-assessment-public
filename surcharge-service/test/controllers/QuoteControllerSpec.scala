package controllers

import models.MerchantConfig
import org.scalatestplus.play._
import org.scalatestplus.play.guice._
import play.api.Application
import play.api.inject.bind
import play.api.inject.guice.GuiceApplicationBuilder
import play.api.libs.json._
import play.api.test.Helpers._
import play.api.test._
import services.MerchantDirectory

import scala.concurrent.{ExecutionContext, Future}

class QuoteControllerSpec extends PlaySpec
  with GuiceOneAppPerSuite {

  val QuoteEndpoint = "/v1/quotes"

  def builder: GuiceApplicationBuilder = new GuiceApplicationBuilder()

  override def fakeApplication(): Application = builder.build()

  def quoteIn(application: Application, body: JsValue) =
    route(application, FakeRequest(POST, QuoteEndpoint).withJsonBody(body)).get

  def quote(body: JsValue) = quoteIn(app, body)

  def quote(merchantId: String, amount: BigDecimal, bin: String) =
    quoteIn(app, Json.obj("merchantId" -> merchantId, "amount" -> amount, "bin" -> bin))

  // the amount exactly as written in the request text, so nothing re-encodes it on the way
  def quoteRaw(text: String) =
    route(app, FakeRequest(POST, QuoteEndpoint).withHeaders(CONTENT_TYPE -> JSON).withBody(text)).get

  def ok(result: Future[play.api.mvc.Result]): JsValue = {
    status(result) mustBe OK
    contentAsJson(result)
  }

  def error(result: Future[play.api.mvc.Result]): String = (contentAsJson(result) \ "error").as[String]

  def num(json: JsValue, field: String): BigDecimal = (json \ field).as[BigDecimal]

  "POST /v1/quotes" should {

    "surcharge a credit card at the merchant's rate" in {
      val json = ok(quote("mer_001", BigDecimal("100.00"), "41111111"))
      (json \ "network").as[String] mustBe "VISA"
      (json \ "cardType").as[String] mustBe "CREDIT"
      (json \ "surchargeable").as[Boolean] mustBe true
      num(json, "rate") mustBe BigDecimal(3)
      num(json, "surcharge") mustBe BigDecimal(3)
      num(json, "total") mustBe BigDecimal(103)
      (json \ "surchargeMinor").as[Long] mustBe 300
      (json \ "totalMinor").as[Long] mustBe 10300
    }

    "return the contract's fields with their JSON types" in {
      val json = ok(quote("mer_001", BigDecimal("100.00"), "41111111")).as[JsObject]
      Seq("merchantId", "currency", "network", "cardType")
        .foreach(f => json(f) mustBe a[JsString])
      Seq("rate", "amount", "surcharge", "total", "currencyExponent", "amountMinor", "surchargeMinor",
        "totalMinor").foreach(f => json(f) mustBe a[JsNumber])
      Seq("currencyExponent", "amountMinor", "surchargeMinor", "totalMinor")
        .foreach(f => json(f).as[BigDecimal].isWhole mustBe true)
      json("surchargeable") mustBe a[JsBoolean]
    }

    "round an exact half up" in {
      // INC-4471: $185.00 visa credit at 2.5% is 4.625, half up to 4.63
      val json = ok(quote("mer_002", BigDecimal(185), "41111111"))
      num(json, "surcharge") mustBe BigDecimal("4.63")
      num(json, "total") mustBe BigDecimal("189.63")
      (json \ "currencyExponent").as[Int] mustBe 2
      (json \ "amountMinor").as[Long] mustBe 18500
      (json \ "surchargeMinor").as[Long] mustBe 463
      (json \ "totalMinor").as[Long] mustBe 18963
    }

    "give exact totals with no floating point artefacts" in {
      val json = ok(quote("mer_001", BigDecimal("128.45"), "41111111"))
      num(json, "surcharge") mustBe BigDecimal("3.85") // 3.8535
      num(json, "total") mustBe BigDecimal("132.30")
      (json \ "totalMinor").as[Long] mustBe 13230

      val raw = ok(quoteRaw("""{"merchantId":"mer_001","amount":0.1,"bin":"41111111"}"""))
      num(raw, "amount") mustBe BigDecimal("0.10")
      (raw \ "amountMinor").as[Long] mustBe 10
    }

    "round whole yen for JPY" in {
      val a = ok(quote("mer_003", BigDecimal(1234), "41111111"))
      (a \ "currency").as[String] mustBe "JPY"
      (a \ "currencyExponent").as[Int] mustBe 0
      num(a, "surcharge") mustBe BigDecimal(37) // 37.02
      (a \ "surchargeMinor").as[Long] mustBe 37
      (a \ "totalMinor").as[Long] mustBe 1271
      num(a, "total") mustBe BigDecimal(1271)

      val b = ok(quote("mer_003", BigDecimal(1250), "41111111"))
      (b \ "surchargeMinor").as[Long] mustBe 38 // 37.5 rounds half up
    }

    "accept a JPY amount with zero decimals and reject one with a fraction" in {
      (ok(quoteRaw("""{"merchantId":"mer_003","amount":100.0,"bin":"41111111"}""")) \ "amountMinor").as[Long] mustBe 100
      val result = quoteRaw("""{"merchantId":"mer_003","amount":100.5,"bin":"41111111"}""")
      status(result) mustBe UNPROCESSABLE_ENTITY
      error(result) mustBe "invalid_amount"
    }

    "reject a USD amount finer than a cent, by value" in {
      status(quoteRaw("""{"merchantId":"mer_001","amount":10.001,"bin":"41111111"}""")) mustBe UNPROCESSABLE_ENTITY
      (ok(quoteRaw("""{"merchantId":"mer_001","amount":10.000,"bin":"41111111"}""")) \ "amountMinor").as[Long] mustBe 1000
      // digits a Double would lose are still seen (play's parser keeps 34 significant digits)
      status(quoteRaw("""{"merchantId":"mer_001","amount":10.0000000000000001,"bin":"41111111"}""")) mustBe UNPROCESSABLE_ENTITY
    }

    "not surcharge a debit card" in {
      val json = ok(quote("mer_001", BigDecimal("100.00"), "40000566"))
      (json \ "cardType").as[String] mustBe "DEBIT"
      (json \ "surchargeable").as[Boolean] mustBe false
      num(json, "rate") mustBe BigDecimal(0)
      num(json, "surcharge") mustBe BigDecimal(0)
      num(json, "total") mustBe BigDecimal(100)
    }

    "not surcharge when the merchant has surcharging off" in {
      val json = ok(quote("mer_004", BigDecimal("40.00"), "41111111"))
      (json \ "surchargeable").as[Boolean] mustBe false
      num(json, "surcharge") mustBe BigDecimal(0)
      num(json, "total") mustBe num(json, "amount")
      (json \ "totalMinor").as[Long] mustBe 4000
    }

    "cap amounts and totals at 2^53 - 1 minor units" in {
      // the cap itself is fine when nothing is added to it
      (ok(quote("mer_004", BigDecimal("90071992547409.91"), "41111111")) \ "totalMinor").as[Long] mustBe 9007199254740991L
      // one cent over the cap, or a surcharge that takes the total over it
      Seq(quote("mer_004", BigDecimal("90071992547409.92"), "41111111"),
        quote("mer_001", BigDecimal("90071992547409.91"), "41111111")).foreach { result =>
        status(result) mustBe UNPROCESSABLE_ENTITY
        contentAsJson(result) mustBe Json.obj("error" -> "invalid_amount")
      }
      // a debit card adds nothing, so the same amount is fine
      status(quote("mer_001", BigDecimal("90071992547409.91"), "40000566")) mustBe OK
    }

    "return a 404 for an unknown merchant" in {
      val result = quote("mer_999", BigDecimal("10.00"), "41111111")
      status(result) mustBe NOT_FOUND
      error(result) mustBe "unknown_merchant"
    }

    "reject a zero or negative amount before the merchant" in {
      status(quote(Json.obj("merchantId" -> "mer_001", "amount" -> 0, "bin" -> "41111111"))) mustBe UNPROCESSABLE_ENTITY
      status(quote("mer_001", BigDecimal(-5), "41111111")) mustBe UNPROCESSABLE_ENTITY
      status(quote("mer_999", BigDecimal(0), "41111111")) mustBe UNPROCESSABLE_ENTITY
    }

    "reject a body missing fields" in {
      val result = quote(Json.obj("merchantId" -> "mer_001"))
      status(result) mustBe BAD_REQUEST
      error(result) mustBe "invalid_request"
    }

    "reject an amount sent as a string" in {
      status(quote(Json.obj("merchantId" -> "mer_001", "amount" -> "10.00", "bin" -> "41111111"))) mustBe BAD_REQUEST
    }

    "return a 500 for a merchant whose currency has no known exponent" in {
      val eur = MerchantConfig("mer_eur", "Euro Shop", "EUR", 3.0, surchargeEnabled = true)
      val application = builder
        .overrides(bind[MerchantDirectory].toInstance(new StubMerchants(eur)))
        .build()
      running(application) {
        val result = quoteIn(application, Json.obj("merchantId" -> "mer_eur", "amount" -> 10, "bin" -> "41111111"))
        status(result) mustBe INTERNAL_SERVER_ERROR
      }
    }
  }

  "GET /v1/bins/:bin" should {

    "describe a known bin" in {
      val result = route(app, FakeRequest(GET, "/v1/bins/55555555")).get
      status(result) mustBe OK
      (contentAsJson(result) \ "network").as[String] mustBe "MASTERCARD"
    }

    "return a 404 for a bin that isn't in the table" in {
      val result = route(app, FakeRequest(GET, "/v1/bins/63900000")).get
      status(result) mustBe NOT_FOUND
    }
  }
}

// a merchant directory that knows one merchant, for configuration faults the fixture doesn't have
class StubMerchants(merchant: MerchantConfig)
  extends MerchantDirectory(null)(ExecutionContext.global) {
  override def find(merchantId: String): Future[Option[MerchantConfig]] =
    Future.successful(Some(merchant).filter(_.merchantId == merchantId))
}
