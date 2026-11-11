package services

import models.{MerchantConfig, Money}
import org.scalatestplus.play.PlaySpec

class SurchargeCalculatorSpec extends PlaySpec {

  "SurchargeCalculator.surchargeMinor" should {

    "apply the rate as a percent" in {
      SurchargeCalculator.surchargeMinor(10000, BigDecimal(3.0)) mustBe 300
      SurchargeCalculator.surchargeMinor(8000, BigDecimal(2.5)) mustBe 200
    }

    "round to the minor unit" in {
      SurchargeCalculator.surchargeMinor(1234, BigDecimal(3.0)) mustBe 37
      SurchargeCalculator.surchargeMinor(4999, BigDecimal(2.5)) mustBe 125
      SurchargeCalculator.surchargeMinor(1999, BigDecimal(3.0)) mustBe 60
    }

    "round an exact half up, not to even" in {
      // INC-4471: $185.00 at 2.5% is 4.625
      SurchargeCalculator.surchargeMinor(18500, BigDecimal(2.5)) mustBe 463
      // ¥1250 at 3% is 37.5
      SurchargeCalculator.surchargeMinor(1250, BigDecimal(3.0)) mustBe 38
    }

    "read the merchant's double rate as its decimal, so an exact tie still rounds up" in {
      // 2.3 as a binary double is 2.29999999999999982..., so new java.math.BigDecimal(2.3) would
      // make 2.3% of 500 come to 11.4999... and round to 11.  The decimal 2.3 gives exactly 11.5
      val merchant = MerchantConfig("mer_x", "X", "USD", 2.3, surchargeEnabled = true)
      SurchargeCalculator.surchargeMinor(500, SurchargeRules.rate(merchant)) mustBe 12
      SurchargeRules.rate(merchant) mustBe BigDecimal("2.3")
    }

    "be zero at a zero rate" in {
      SurchargeCalculator.surchargeMinor(25000, BigDecimal(0)) mustBe 0
    }
  }

  "Money" should {

    "convert an amount to minor units by value, not by scale" in {
      Money.toMinor(BigDecimal("185"), 2) mustBe Some(18500)
      Money.toMinor(BigDecimal("10.000"), 2) mustBe Some(1000)
      Money.toMinor(BigDecimal("100.0"), 0) mustBe Some(100)
      Money.toMinor(BigDecimal("1E+3"), 0) mustBe Some(1000)
    }

    "reject an amount finer than the minor unit" in {
      Money.toMinor(BigDecimal("10.001"), 2) mustBe None
      Money.toMinor(BigDecimal("100.5"), 0) mustBe None
      Money.toMinor(BigDecimal("10.0000000000000000000000000000000000001"), 2) mustBe None
    }

    "reject an amount too large for a Long" in {
      Money.toMinor(BigDecimal("1E+30"), 2) mustBe None
    }

    "cap minor units at 2^53 - 1" in {
      Money.toMinor(BigDecimal("90071992547409.91"), 2) mustBe Some(9007199254740991L)
      Money.toMinor(BigDecimal("90071992547409.92"), 2) mustBe None
      Money.toMinor(BigDecimal("9007199254740992"), 0) mustBe None
    }

    "convert minor units back exactly" in {
      Money.fromMinor(13230, 2) mustBe BigDecimal("132.30")
      Money.fromMinor(13230, 2).toString mustBe "132.30"
      Money.fromMinor(1234, 0) mustBe BigDecimal(1234)
    }
  }
}
