package services

import models.MerchantConfig
import org.scalatestplus.play.PlaySpec
import play.api.inject.bind
import play.api.inject.guice.GuiceApplicationBuilder
import play.api.{Configuration, Environment}
import services.onboarding.OnboardingClient

import java.util.concurrent.atomic.{AtomicInteger, AtomicLong, AtomicReference}
import java.util.concurrent.{CountDownLatch, Executors, TimeUnit}
import scala.concurrent.duration._
import scala.concurrent.{Await, ExecutionContext, Future}

class MerchantDirectorySpec extends PlaySpec {

  val Ttl: FiniteDuration = 30.seconds

  /** An onboarding client that counts its calls and can be made to fail or wait, around the real
    * fixture lookup.
    */
  class CountingOnboarding extends OnboardingClient(Environment.simple(),
    Configuration("surcharge.merchants.resource" -> "merchants.json")) {
    val calls = new AtomicInteger
    val lastThread = new AtomicReference[String]
    /** Fails the next call when set, then clears itself. */
    @volatile var failNext = false
    /** Holds every call until it's released, when set. */
    @volatile var gate: Option[CountDownLatch] = None

    override def fetchMerchant(merchantId: String): Option[MerchantConfig] = {
      calls.incrementAndGet()
      lastThread.set(Thread.currentThread.getName)
      gate.foreach(_.await(10, TimeUnit.SECONDS))
      if (failNext) {
        failNext = false
        throw new RuntimeException("onboarding is down")
      }
      super.fetchMerchant(merchantId)
    }
  }

  /** A directory over a counting client, with a clock the test moves by hand. */
  def directory(ttl: FiniteDuration = Ttl): (MerchantDirectory, CountingOnboarding, AtomicLong) = {
    val onboarding = new CountingOnboarding
    val clock = new AtomicLong(0L)
    (new MerchantDirectory(onboarding, ttl, () => clock.get())(ExecutionContext.global), onboarding, clock)
  }

  def await[A](f: Future[A]): A = Await.result(f, 10.seconds)

  "MerchantDirectory.find" should {

    "serve a merchant from the cache until the ttl has passed" in {
      val (merchants, onboarding, clock) = directory()
      await(merchants.find("mer_001")).map(_.merchantId) mustBe Some("mer_001")
      clock.set(Ttl.toNanos - 1)
      await(merchants.find("mer_001")).map(_.merchantId) mustBe Some("mer_001")
      onboarding.calls.get mustBe 1

      clock.set(Ttl.toNanos)
      await(merchants.find("mer_001")).map(_.merchantId) mustBe Some("mer_001")
      onboarding.calls.get mustBe 2
    }

    "cache each merchant separately" in {
      val (merchants, onboarding, _) = directory()
      Seq("mer_001", "mer_002", "mer_001", "mer_002").foreach(id => await(merchants.find(id)))
      onboarding.calls.get mustBe 2
    }

    "share one onboarding call between concurrent misses" in {
      val (merchants, onboarding, _) = directory()
      val gate = new CountDownLatch(1)
      onboarding.gate = Some(gate)
      val pool = Executors.newFixedThreadPool(8)
      try {
        val callers = ExecutionContext.fromExecutor(pool)
        val started = new CountDownLatch(8)
        val results = (1 to 8).map(_ => Future { started.countDown(); merchants.find("mer_002") }(callers))
        started.await(10, TimeUnit.SECONDS) mustBe true
        val lookups = results.map(await)
        gate.countDown()
        lookups.map(await(_).map(_.merchantId)).distinct mustBe Seq(Some("mer_002"))
        onboarding.calls.get mustBe 1
      } finally {
        pool.shutdown()
      }
    }

    "not cache an unknown merchant, so one onboarded later is found" in {
      val (merchants, onboarding, _) = directory()
      await(merchants.find("mer_unknown")) mustBe None
      await(merchants.find("mer_unknown")) mustBe None
      onboarding.calls.get mustBe 2
    }

    "not cache a failed call" in {
      val (merchants, onboarding, _) = directory()
      onboarding.failNext = true
      a[RuntimeException] mustBe thrownBy { await(merchants.find("mer_001")) }
      await(merchants.find("mer_001")).map(_.merchantId) mustBe Some("mer_001")
      onboarding.calls.get mustBe 2
    }

    "call onboarding every time when the ttl is zero" in {
      val (merchants, onboarding, _) = directory(Duration.Zero)
      (1 to 3).foreach(_ => await(merchants.find("mer_001")))
      onboarding.calls.get mustBe 3
    }

    "run the onboarding call on the onboarding dispatcher, not Play's default one" in {
      val onboarding = new CountingOnboarding
      val app = new GuiceApplicationBuilder().overrides(bind[OnboardingClient].toInstance(onboarding)).build()
      try {
        await(app.injector.instanceOf[MerchantDirectory].find("mer_001")).map(_.merchantId) mustBe Some("mer_001")
        onboarding.lastThread.get must include("surcharge.onboarding.dispatcher")
      } finally {
        await(app.stop())
      }
    }
  }
}
