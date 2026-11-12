package services

import models.MerchantConfig
import play.api.Configuration
import services.onboarding.{OnboardingClient, OnboardingExecutionContext}

import java.util.concurrent.ConcurrentHashMap
import jakarta.inject._
import scala.concurrent.duration.FiniteDuration
import scala.concurrent.{ExecutionContext, Future, Promise, blocking}
import scala.util.{Failure, Success}

/** Merchant config from the onboarding service, cached for `ttl`.
  *
  * A merchant that is found is cached for `ttl` from the start of the fetch, so a change made in
  * onboarding takes effect here within `ttl`. That includes turning surcharging off (rule 6 in
  * docs/surcharging.md) and a rate change: for up to `ttl` after either, quotes still use the old
  * config. Concurrent lookups of a merchant that isn't cached share one onboarding call. Unknown
  * merchants and failed calls aren't cached, so the next lookup asks again and the cache only ever
  * holds real merchants.
  *
  * @param ttl how long a found merchant is served from the cache; zero turns the cache off
  * @param nanoTime the clock for expiry, `System.nanoTime` outside tests
  * @param onboardingEc where the blocking onboarding call runs, never Play's default dispatcher
  */
@Singleton
class MerchantDirectory(onboarding: OnboardingClient, ttl: FiniteDuration, nanoTime: () => Long)
                       (implicit onboardingEc: ExecutionContext) {

  @Inject()
  def this(onboarding: OnboardingClient, onboardingEc: OnboardingExecutionContext, config: Configuration) =
    this(onboarding, config.get[FiniteDuration]("surcharge.merchants.cacheTtl"), () => System.nanoTime())(onboardingEc)

  require(ttl.length >= 0, s"merchant cache ttl must not be negative, was $ttl")

  private val ttlNanos = ttl.toNanos

  /** A cached or in-flight lookup, served until `expiresAt` (a `nanoTime` value). */
  private final class Entry(val result: Future[Option[MerchantConfig]], val expiresAt: Long) {
    // nanoTime can wrap, so compare the difference rather than the values
    def isLive(now: Long): Boolean = now - expiresAt < 0
  }

  private val cache = new ConcurrentHashMap[String, Entry]()

  /** The merchant's config, or None if onboarding doesn't know it. */
  def find(merchantId: String): Future[Option[MerchantConfig]] = {
    val now = nanoTime()
    val cached = cache.get(merchantId)
    if (cached != null && cached.isLive(now)) cached.result
    else {
      val promise = Promise[Option[MerchantConfig]]()
      val fresh = new Entry(promise.future, now + ttlNanos)
      // compute is atomic per key, so of several concurrent misses only one installs its entry and
      // calls onboarding; the others get that entry's future
      val entry = cache.compute(merchantId, (_, existing) =>
        if (existing != null && existing.isLive(now)) existing else fresh)
      if (entry eq fresh) {
        Future(blocking(onboarding.fetchMerchant(merchantId))).onComplete { result =>
          // drop an entry that mustn't be cached before completing, so no caller sees the result
          // and then gets it again from the cache
          result match {
            case Success(Some(_)) => ()
            case Success(None) | Failure(_) => cache.remove(merchantId, fresh)
          }
          promise.complete(result)
        }
      }
      entry.result
    }
  }
}
