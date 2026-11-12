package services.onboarding

import org.apache.pekko.actor.ActorSystem
import play.api.libs.concurrent.CustomExecutionContext

import jakarta.inject._

/** The execution context for blocking onboarding calls: the bounded Pekko dispatcher configured at
  * `surcharge.onboarding.dispatcher` in application.conf.
  */
@Singleton
class OnboardingExecutionContext @Inject()(system: ActorSystem)
  extends CustomExecutionContext(system, "surcharge.onboarding.dispatcher")
