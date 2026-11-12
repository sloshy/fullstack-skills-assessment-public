package services

import models.{BinRange, CardInfo, CardType}
import play.api.{Configuration, Environment}

import java.util.zip.GZIPInputStream
import jakarta.inject._
import scala.io.Source

/** The bin table, answering each lookup with a binary search.
  *
  * At load the ranges are cut into disjoint segments, each holding the narrowest range that covers
  * it, so a lookup is one binary search over the segment starts and allocates nothing.
  *
  * @param ranges bounds must be 8 ASCII digits with `start <= end`, or the table refuses to load
  */
class BinTable(ranges: IndexedSeq[BinRange]) {

  private val (segmentStarts, segmentCards) = BinTable.segments(ranges)

  /** The number of ranges loaded. */
  // a val, so the table doesn't keep every BinRange alive just to count them
  val size: Int = ranges.size

  /** The card info for a bin. Only the first 8 digits matter. Issuers carve narrower product
    * ranges out of broader ones so ranges can overlap; the narrowest match wins, and of equally
    * narrow matches the one listed first.
    *
    * Callers validate with `BinTable.normalize` first; anything it rejects is a programming
    * error here.
    */
  def lookup(bin: String): Option[CardInfo] = {
    val b = BinTable.binNumber(bin)
    // the input isn't in the message, it may be a whole card number
    if (b < 0) throw new IllegalArgumentException("not a valid bin")
    val found = java.util.Arrays.binarySearch(segmentStarts, b)
    // a miss returns -(insertion point) - 1, and the segment holding b starts just before that point
    val segment = if (found >= 0) found else -found - 2
    if (segment < 0) None else segmentCards(segment)
  }
}

object BinTable {
  val BinLength = 8
  val MaxCardNumberLength = 19

  /** The bin from a bin or card number, or None if the input isn't one. After removing spaces and
    * dashes the input must be 8 to 19 ASCII digits, and the first 8 are the bin (DECISIONS.md 011).
    */
  def normalize(input: String): Option[String] = {
    val digits = input.filterNot(c => c == ' ' || c == '-')
    // DECISIONS.md 011: shorter input is never zero-padded, that would guess the card type
    val valid = digits.length >= BinLength && digits.length <= MaxCardNumberLength &&
      digits.forall(c => c >= '0' && c <= '9')
    if (valid) Some(digits.take(BinLength)) else None
  }

  /** `normalize(input)` as a number, or -1 where `normalize` gives None. Same rules, but it
    * allocates nothing, for the lookup.
    */
  private[services] def binNumber(input: String): Int = {
    var digits = 0
    var bin = 0
    var i = 0
    while (i < input.length) {
      val c = input.charAt(i)
      if (c >= '0' && c <= '9') {
        digits += 1
        if (digits > MaxCardNumberLength) return -1
        if (digits <= BinLength) bin = bin * 10 + (c - '0')
      } else if (c != ' ' && c != '-') {
        return -1
      }
      i += 1
    }
    if (digits >= BinLength) bin else -1
  }

  /** Cuts the ranges into disjoint segments, each mapped to the narrowest range covering all of it
    * (the first listed on a tie).
    *
    * @return the segment starts, ascending, and for each the card info lookup returns for a bin from
    *         that start up to the next one: None where no range covers it. The last segment runs to
    *         the top of the bin space.
    */
  private def segments(ranges: IndexedSeq[BinRange]): (Array[Int], Array[Option[CardInfo]]) = {
    val n = ranges.size
    val starts = new Array[Int](n)
    val ends = new Array[Int](n)
    ranges.indices.foreach { i =>
      val r = ranges(i)
      starts(i) = bound(r.start, i)
      ends(i) = bound(r.end, i)
      require(starts(i) <= ends(i), s"bin range ${i + 1}: start ${r.start} is after end ${r.end}")
    }
    val cards: Array[Option[CardInfo]] = ranges.map(r => Some(CardInfo(r.network, r.cardType, r.country))).toArray
    val byStart = Array.range(0, n).sortBy(starts(_))

    // the covering ranges only change where a range starts or just after one ends
    val points = (starts ++ ends.map(_ + 1)).distinct.sorted

    // the ranges that have started, narrowest first and then in list order; ranges that have ended
    // are dropped when they reach the head, since only the head is ever read
    val open = new java.util.PriorityQueue[java.lang.Long]()
    // widths are under 10^8, so width and index pack into one Long that orders by width then index
    def key(i: Int): Long = (ends(i) - starts(i)).toLong << 32 | i
    def index(key: Long): Int = (key & 0xffffffffL).toInt

    val segmentStarts = Array.newBuilder[Int]
    val segmentRanges = Array.newBuilder[Int]
    var last = -2
    var next = 0
    points.foreach { p =>
      while (next < n && starts(byStart(next)) == p) {
        open.add(key(byStart(next)))
        next += 1
      }
      while (!open.isEmpty && ends(index(open.peek)) < p) open.poll()
      val narrowest = if (open.isEmpty) -1 else index(open.peek)
      if (narrowest != last) {
        segmentStarts += p
        segmentRanges += narrowest
        last = narrowest
      }
    }
    (segmentStarts.result(), segmentRanges.result().map(i => if (i < 0) None else cards(i)))
  }

  /** A range bound as a number. */
  private def bound(digits: String, index: Int): Int = {
    // the old lookup compared bounds as strings, which only orders them as numbers at a fixed length
    require(digits.length == BinLength && digits.forall(c => c >= '0' && c <= '9'),
      s"bin range ${index + 1}: bound '$digits' is not $BinLength digits")
    digits.toInt
  }

  /** Parses bin table CSV lines, `range_start,range_end,network,card_type,country`, with a
    * header row.
    */
  def parse(lines: Iterator[String]): Vector[BinRange] = {
    lines.zipWithIndex.drop(1)
      .filter(_._1.nonEmpty)
      .map { case (line, index) =>
        val cols = line.split(',')
        val network = cols(2).trim
        val cardType = cols(3).trim
        // network and card_type end up in signed quotes, so a value that can't be signed fails the
        // load (at startup, the provider is eager) rather than surfacing later as a 500 on every
        // quote for that range
        Seq("network" -> network, "card_type" -> cardType).foreach { case (name, value) =>
          if (!QuoteSigning.isToken(value))
            throw new IllegalStateException(s"bin table line ${index + 1}: $name '$value' is not [A-Za-z0-9_-]+")
        }
        BinRange(cols(0), cols(1), network, CardType.parse(cardType), cols(4))
      }
      .toVector
  }
}

@Singleton
class BinTableProvider @Inject()(env: Environment, config: Configuration)
  extends com.google.inject.Provider[BinTable] with com.typesafe.scalalogging.LazyLogging {

  override def get(): BinTable = {
    val resource = config.get[String]("surcharge.bins.resource")
    val stream = env.resourceAsStream(resource)
      .getOrElse(throw new IllegalStateException(s"bin table $resource not found on the classpath"))

    val source = Source.fromInputStream(new GZIPInputStream(stream), "UTF-8")
    try {
      val table = new BinTable(BinTable.parse(source.getLines()))
      logger.info(s"loaded ${table.size} bin ranges from $resource")
      table
    } finally {
      source.close()
    }
  }
}
