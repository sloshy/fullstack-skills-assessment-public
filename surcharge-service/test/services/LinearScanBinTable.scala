package services

import models.{BinRange, CardInfo}

/** The original bin lookup, a linear scan over every range, kept as the reference that
  * `BinTable`'s binary search is checked against. Test only: it scans all ranges per lookup.
  */
class LinearScanBinTable(ranges: IndexedSeq[BinRange]) {

  /** The original lookup, unchanged. */
  def lookup(bin: String): Option[CardInfo] = {
    val b = BinTable.normalize(bin).getOrElse(throw new IllegalArgumentException("not a valid bin"))
    ranges.filter(_.contains(b))
      .sortBy(_.width)
      .headOption
      .map(r => CardInfo(r.network, r.cardType, r.country))
  }

  /** `bins.map(lookup)`, as one scan over the ranges instead of one per bin, so a million bins
    * check in seconds rather than an hour.
    *
    * Like `lookup` it visits every range in list order and tests `contains` on the strings. Each
    * range claims the bins it contains where it is strictly narrower than the best so far, which
    * is what `filter`, the stable `sortBy(_.width)` and `headOption` pick: the narrowest, and the
    * first listed on a tie. The bins a range contains are found by binary search over the sorted
    * bins rather than by testing each one, which is the only difference.
    */
  def lookupAll(bins: IndexedSeq[String]): IndexedSeq[Option[CardInfo]] = {
    val normalized = bins.map(b => BinTable.normalize(b).getOrElse(throw new IllegalArgumentException("not a valid bin")))
    val keys = normalized.distinct.sorted.toArray
    val best = Array.fill(keys.length)(-1)
    ranges.indices.foreach { i =>
      val r = ranges(i)
      var k = lowerBound(keys, r.start)
      while (k < keys.length && r.contains(keys(k))) {
        if (best(k) < 0 || r.width < ranges(best(k)).width) best(k) = i
        k += 1
      }
    }
    val index = keys.zipWithIndex.toMap
    normalized.map { b =>
      val i = best(index(b))
      if (i < 0) None else Some(CardInfo(ranges(i).network, ranges(i).cardType, ranges(i).country))
    }
  }

  /** The first index whose key is at least `start`. */
  private def lowerBound(keys: Array[String], start: String): Int = {
    var lo = 0
    var hi = keys.length
    while (lo < hi) {
      val mid = (lo + hi) >>> 1
      if (keys(mid) < start) lo = mid + 1 else hi = mid
    }
    lo
  }
}
