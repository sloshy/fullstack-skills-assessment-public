import { Request, Response, NextFunction } from 'express';
import { describeError, logEvent } from '../logger';
import { UpstreamError } from '../types';

interface Classified {
  status: number;
  // What the client sees
  clientMessage: string;
  // What the log sees. Never the message of an error we didn't write: body-parser's
  // SyntaxError quotes raw body text, which can be card digits.
  logMessage: string;
}

function classify(err: Error): Classified {
  // Our own errors: the message is a code we chose and is safe to show and log
  if (err instanceof UpstreamError) {
    return { status: err.status, clientMessage: err.message, logMessage: describeError(err) };
  }

  const { status, type } = err as { status?: unknown; type?: unknown };
  const typeText = typeof type === 'string' ? type : err.name;

  // body-parser errors (bad JSON, too large, bad encoding) carry a 4xx status and a type
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const clientMessage = type === 'entity.parse.failed' ? 'invalid_json' : 'invalid_request';
    return { status, clientMessage, logMessage: `client error: ${typeText}` };
  }

  return { status: 500, clientMessage: 'Internal server error', logMessage: describeError(err) };
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  const { status, clientMessage, logMessage } = classify(err);

  // Route, status and error only: no headers (the API key) and no body (card data)
  logEvent(status >= 500 ? 'ERROR' : 'WARN', 'middleware.errorHandler', logMessage, {
    route: `${req.method} ${req.originalUrl.split('?')[0]}`,
    status,
    headers_sent: res.headersSent,
  });

  // Too late for a clean error response; Express's default handler closes the connection
  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(status).json({ error: clientMessage });
}
