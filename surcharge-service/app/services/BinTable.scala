package services

import models.{BinRange, CardInfo, CardType}
import play.api.{Configuration, Environment}

import java.util.zip.GZIPInputStream
import jakarta.inject._
import scala.io.Source

class BinTable(ranges: IndexedSeq[BinRange]) {

  def size: Int = ranges.size

  // only the first 8 digits matter.  issuers carve narrower product ranges out of broader
  // ones so ranges can overlap, the narrowest match wins.  Callers validate with
  // BinTable.normalize first; anything it rejects is a programming error here
  def lookup(bin: String): Option[CardInfo] = {
    // the input isn't in the message, it may be a whole card number
    val b = BinTable.normalize(bin).getOrElse(throw new IllegalArgumentException("not a valid bin"))
    ranges.filter(_.contains(b))
      .sortBy(_.width)
      .headOption
      .map(r => CardInfo(r.network, r.cardType, r.country))
  }
}

object BinTable {
  val BinLength = 8
  val MaxCardNumberLength = 19

  // DECISIONS.md 011: after removing spaces and dashes the input must be 8 to 19 ASCII digits, and
  // the first 8 are the bin.  Shorter input is never zero-padded, that would guess the card type
  def normalize(input: String): Option[String] = {
    val digits = input.filterNot(c => c == ' ' || c == '-')
    val valid = digits.length >= BinLength && digits.length <= MaxCardNumberLength &&
      digits.forall(c => c >= '0' && c <= '9')
    if (valid) Some(digits.take(BinLength)) else None
  }

  // range_start,range_end,network,card_type,country with a header row.  network and card_type
  // end up in signed quotes, so a value that can't be signed fails the load (at startup, the
  // provider is eager) rather than surfacing later as a 500 on every quote for that range
  def parse(lines: Iterator[String]): Vector[BinRange] = {
    lines.zipWithIndex.drop(1)
      .filter(_._1.nonEmpty)
      .map { case (line, index) =>
        val cols = line.split(',')
        val network = cols(2).trim
        val cardType = cols(3).trim
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
