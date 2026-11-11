package services

import models.{BinRange, CardType}
import org.scalatestplus.play.PlaySpec

class BinTableSpec extends PlaySpec {

  val table = new BinTable(Vector(
    BinRange("40000000", "40009999", "VISA", CardType.Credit, "US"),
    BinRange("40000500", "40000599", "VISA", CardType.Debit, "US"),
    BinRange("40000550", "40000559", "VISA", CardType.Prepaid, "US"),
    BinRange("55555500", "55555599", "MASTERCARD", CardType.Credit, "US")
  ))

  "BinTable.lookup" should {

    "use the first 8 digits of a card number" in {
      table.lookup("5555555555554444").map(_.network) mustBe Some("MASTERCARD")
    }

    "ignore spaces and dashes" in {
      table.lookup("5555 5555-5555 4444").map(_.network) mustBe Some("MASTERCARD")
    }

    "pick the narrowest of overlapping ranges" in {
      table.lookup("4000000000000002").map(_.cardType) mustBe Some(CardType.Credit)
      table.lookup("4000056655665556").map(_.cardType) mustBe Some(CardType.Debit)
      table.lookup("4000055500000000").map(_.cardType) mustBe Some(CardType.Prepaid)
    }

    "include both ends of a range" in {
      table.lookup("40000599").map(_.cardType) mustBe Some(CardType.Debit)
      table.lookup("40000600").map(_.cardType) mustBe Some(CardType.Credit)
    }

    "refuse a bin under 8 digits rather than padding it" in {
      an[IllegalArgumentException] mustBe thrownBy { table.lookup("555555") }
      an[IllegalArgumentException] mustBe thrownBy { table.lookup("5555555") }
    }

    "return None when no range matches" in {
      table.lookup("6390000000000005") mustBe None
    }
  }

  "BinTable.normalize" should {

    "take the first 8 of 8 to 19 digits" in {
      BinTable.normalize("55555555") mustBe Some("55555555")
      BinTable.normalize("378282246310005") mustBe Some("37828224")
      BinTable.normalize("5555555555554444") mustBe Some("55555555")
      BinTable.normalize("4111111111111111111") mustBe Some("41111111")
    }

    "remove spaces and dashes" in {
      BinTable.normalize("5555 5555-5555 4444") mustBe Some("55555555")
      BinTable.normalize("4111-1111") mustBe Some("41111111")
    }

    "refuse anything else, with no zero-padding" in {
      Seq("", "555555", "5555555", "41111111111111111111", "4111abcd", "4111abcd11111111",
        "4111\t1111", "41111111x", "４１１１１１１１")
        .foreach(input => BinTable.normalize(input) mustBe None)
    }
  }
}
