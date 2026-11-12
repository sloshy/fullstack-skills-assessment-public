package services

import models.BinRange
import org.scalatestplus.play.PlaySpec

import java.util.zip.GZIPInputStream
import scala.io.Source
import scala.util.Random

/** Checks the binary search against the original linear scan on the real bin table. */
class BinTableEquivalenceSpec extends PlaySpec {

  lazy val ranges: Vector[BinRange] = {
    val stream = getClass.getResourceAsStream("/bins.csv.gz")
    val source = Source.fromInputStream(new GZIPInputStream(stream), "UTF-8")
    try BinTable.parse(source.getLines()) finally source.close()
  }
  lazy val table = new BinTable(ranges)
  lazy val reference = new LinearScanBinTable(ranges)

  /** The bins, as given, where the binary search disagrees with the linear scan, run once per bin. */
  def disagreements(bins: Seq[String]): Seq[String] = {
    val all = bins.toArray
    // each scan reads every range, so spread them over the cores
    java.util.stream.IntStream.range(0, all.length).parallel()
      .filter(i => table.lookup(all(i)) != reference.lookup(all(i)))
      .toArray.toSeq.map(all(_))
  }

  /** The same, against the linear scan run once for all the bins (`LinearScanBinTable.lookupAll`). */
  def disagreementsInOneScan(bins: IndexedSeq[String]): Seq[String] =
    bins.zip(reference.lookupAll(bins)).collect { case (b, expected) if table.lookup(b) != expected => b }

  def eightDigits(n: Int): String = f"$n%08d"

  "BinTable.lookup" should {

    "load the whole table" in {
      table.size mustBe 221542
    }

    "agree with the linear scan on every test card" in {
      // README.md's test cards, as typed, and the load test's known bins
      val cards = Seq("4111 1111 1111 1111", "4000 0566 5566 5556", "4847 1800 0000 0009", "5555 5555 5555 4444",
        "5200 8282 8282 8210", "3782 822463 10005", "6011 1111 1111 1117", "6390 0000 0000 0005",
        "4000 0000 0000 0002", "4000 0000 0000 0259",
        "41111111", "40000566", "55555555", "52008282", "48471800", "37828224", "60111111")
      disagreements(cards) mustBe empty
      // they include hits and the documented miss, so both paths are compared
      cards.count(table.lookup(_).isEmpty) mustBe 1
    }

    "agree with the linear scan at both ends of every range and one past each" in {
      val bins = ranges.flatMap { r =>
        val (start, end) = (r.start.toInt, r.end.toInt)
        Seq(start - 1, start, end, end + 1)
      }.distinct.filter(n => n >= 0 && n <= 99999999).map(eightDigits)
      bins.size must be > ranges.size * 2
      disagreementsInOneScan(bins) mustBe empty
    }

    "agree with the linear scan on 200,000 random bins" in {
      val random = new Random(20261111L)
      val bins = IndexedSeq.fill(200000)(eightDigits(random.nextInt(100000000)))
      disagreementsInOneScan(bins) mustBe empty
      // about a fifth of the bin space is in the table, so the sample exercises hits and misses
      bins.count(table.lookup(_).isDefined) must be > 30000
    }

    "check against a one-scan reference that matches the per-bin linear scan" in {
      // lookupAll stands in for lookup above only because a million per-bin scans take too long;
      // this shows the two agree, on bins sampled from both tests above
      val random = new Random(20261112L)
      val sample = IndexedSeq.fill(1000)(eightDigits(random.nextInt(100000000))) ++
        IndexedSeq.fill(1000) {
          val r = ranges(random.nextInt(ranges.size))
          eightDigits(Seq(r.start.toInt - 1, r.start.toInt, r.end.toInt, r.end.toInt + 1)(random.nextInt(4)).max(0).min(99999999))
        }
      reference.lookupAll(sample) mustBe sample.map(reference.lookup)
      disagreements(sample) mustBe empty
    }
  }
}
