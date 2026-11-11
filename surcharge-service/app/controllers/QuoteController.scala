package controllers

import models.{QuoteError, QuoteRequest}
import play.api.libs.json._
import play.api.mvc._
import services.QuoteService

import jakarta.inject._
import scala.concurrent.{ExecutionContext, Future}

@Singleton
class QuoteController @Inject()(cc: ControllerComponents, quotes: QuoteService)(implicit ec: ExecutionContext)
  extends AbstractController(cc) with com.typesafe.scalalogging.LazyLogging {

  def create(): Action[JsValue] = Action.async(parse.json) { request =>
    request.body.validate[QuoteRequest] match {
      case JsError(errors) =>
        Future.successful(BadRequest(Json.obj("error" -> "invalid_request", "details" -> JsError.toJson(errors))))
      case JsSuccess(q, _) =>
        quotes.quote(q).map {
          case Right(quote) =>
            logger.info(s"mid:${quote.merchantId} quoted ${quote.amount} ${quote.currency} ${quote.network}/${quote.cardType.code} surcharge:${quote.surcharge}")
            Ok(Json.toJson(quote))
          case Left(QuoteError.UnknownMerchant) => NotFound(Json.obj("error" -> "unknown_merchant"))
          case Left(QuoteError.InvalidAmount) => UnprocessableEntity(Json.obj("error" -> "invalid_amount"))
          case Left(QuoteError.UnsupportedCurrency(currency)) =>
            logger.error(s"mid:${q.merchantId} has currency $currency with no known exponent, a merchant config fault")
            InternalServerError(Json.obj("error" -> "internal_error"))
        }
    }
  }
}
