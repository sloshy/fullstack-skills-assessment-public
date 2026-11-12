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

  "BinTable.parse" should {

    val header = "range_start,range_end,network,card_type,country"

    "read ranges after the header" in {
      BinTable.parse(Iterator(header, "40000000,40009999,VISA,CREDIT,US")) mustBe
        Vector(BinRange("40000000", "40009999", "VISA", CardType.Credit, "US"))
    }

    "store the trimmed network and card type it validated" in {
      BinTable.parse(Iterator(header, "40000000,40009999, VISA , CREDIT ,US")) mustBe
        Vector(BinRange("40000000", "40009999", "VISA", CardType.Credit, "US"))
    }

    "refuse a network or card type that can't be signed" in {
      Seq("40000000,40009999,VI|SA,CREDIT,US", "40000000,40009999,VISA,CRE DIT,US", "40000000,40009999,,CREDIT,US")
        .foreach { row =>
          val e = the[IllegalStateException] thrownBy { BinTable.parse(Iterator(header, row)) }
          e.getMessage must include("line 2")
        }
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

  "BinTable.binNumber" should {

    "follow normalize exactly" in {
      val random = new scala.util.Random(20261111L)
      val alphabet = "0123456789 -x\t４"
      val generated = Seq.fill(20000)(Seq.fill(random.nextInt(24))(alphabet(random.nextInt(alphabet.length))).mkString)
      val fixed = Seq("", "555555", "5555555", "55555555", "00000000", "99999999", "5555 5555-5555 4444",
        "4111111111111111111", "41111111111111111111", "4111abcd", "--41111111--", " ", "-")
      (fixed ++ generated).foreach { input =>
        withClue(s"'$input'") {
          BinTable.binNumber(input) mustBe BinTable.normalize(input).fold(-1)(_.toInt)
        }
      }
    }
  }

  "new BinTable" should {

    "refuse a bound that isn't 8 digits, or a range that ends before it starts" in {
      Seq(BinRange("4000000", "40009999", "VISA", CardType.Credit, "US"),
        BinRange("40000000", "4000999x", "VISA", CardType.Credit, "US"),
        BinRange("40009999", "40000000", "VISA", CardType.Credit, "US"))
        .foreach(r => an[IllegalArgumentException] mustBe thrownBy { new BinTable(Vector(r)) })
    }

    "pick the first listed of equally narrow matches, like the linear scan" in {
      val twins = new BinTable(Vector(
        BinRange("40000000", "40000099", "VISA", CardType.Debit, "US"),
        BinRange("40000000", "40000099", "VISA", CardType.Credit, "US")))
      twins.lookup("40000050").map(_.cardType) mustBe Some(CardType.Debit)
    }

    "find the narrowest match when ranges partly overlap or nest deeply" in {
      val ranges = Vector(
        BinRange("10000000", "19999999", "A", CardType.Credit, "US"),
        BinRange("15000000", "29999999", "B", CardType.Credit, "US"),
        BinRange("16000000", "16999999", "C", CardType.Credit, "US"),
        BinRange("16500000", "16599999", "D", CardType.Credit, "US"),
        BinRange("16550000", "16550000", "E", CardType.Credit, "US"),
        BinRange("00000000", "99999999", "F", CardType.Credit, "US"))
      val fast = new BinTable(ranges)
      val reference = new LinearScanBinTable(ranges)
      val points = ranges.flatMap(r => Seq(r.start.toInt - 1, r.start.toInt, r.end.toInt, r.end.toInt + 1))
        .filter(n => n >= 0 && n <= 99999999).map(n => f"$n%08d")
      points.foreach(b => withClue(b) { fast.lookup(b) mustBe reference.lookup(b) })
      fast.lookup("16550000").map(_.network) mustBe Some("E")
      fast.lookup("25000000").map(_.network) mustBe Some("B")
    }

    "return None from an empty table" in {
      new BinTable(Vector.empty).lookup("41111111") mustBe None
    }
  }
}
