import com.google.inject.AbstractModule
import services.{BinTable, BinTableProvider, QuoteSigner}

import java.time.Clock

class Module extends AbstractModule {

  override def configure() = {
    // load the bin table at startup rather than on the first quote
    bind(classOf[BinTable]).toProvider(classOf[BinTableProvider]).asEagerSingleton()
    // check the signing key at startup, so a bad key stops the service before it takes traffic
    bind(classOf[QuoteSigner]).asEagerSingleton()
    // quote expiry reads the time from here, so tests can fix it
    bind(classOf[Clock]).toInstance(Clock.systemUTC())
  }
}
