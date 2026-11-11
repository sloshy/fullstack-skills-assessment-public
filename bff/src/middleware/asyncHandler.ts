import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so every rejection, and every synchronous throw, goes to the
 * error middleware.
 *
 * Express 4 ignores the promise an async handler returns, so without this a rejection becomes
 * an unhandledRejection and Node 22 exits the process (INC-4493).
 */
export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req as Req, res, next))
      .catch(next);
  };
}
