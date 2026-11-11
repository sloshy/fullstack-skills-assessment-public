package controllers

import play.api.libs.json._
import play.api.mvc._
import services.BinTable

import jakarta.inject._

@Singleton
class BinController @Inject()(cc: ControllerComponents, bins: BinTable) extends AbstractController(cc) {

  def show(bin: String): Action[AnyContent] = Action {
    BinTable.normalize(bin) match {
      case None => BadRequest(Json.obj("error" -> "invalid_bin"))
      case Some(b) =>
        bins.lookup(b) match {
          case Some(card) => Ok(Json.toJson(card))
          case None => NotFound(Json.obj("error" -> "unknown_bin"))
        }
    }
  }
}
