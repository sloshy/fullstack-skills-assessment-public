import { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 ignores the promise an async handler returns, so a rejection becomes an
// unhandledRejection and Node 22 exits the process (INC-4493). Send every rejection, and
// every synchronous throw, to the error middleware instead.
export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req as Req, res, next))
      .catch(next);
  };
}
