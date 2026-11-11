import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    if (req.path === '/health') return;

    const processingTimeMs = Date.now() - startTime;

    // Same JSON line format as the other services. Enough to reconstruct who saw what
    // (INC-4486): the merchant behind the key, and whether a list came from the cache.
    // Never the API key or card data.
    const logEntry = {
      '@timestamp': new Date().toISOString(),
      level: res.statusCode >= 500 ? 'ERROR' : 'INFO',
      logger_name: 'middleware.requestLogger',
      message: `${req.method} u:${req.originalUrl} r:${res.statusCode} t:${processingTimeMs}ms`,
      ...withDefinedValues({
        merchant_id: (req as AuthenticatedRequest).merchantId,
        cache: res.locals.cache,
        surcharge_fallback: res.locals.surchargeFallback,
      }),
    };
    console.log(JSON.stringify(logEntry));
  });

  next();
}

function withDefinedValues(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
