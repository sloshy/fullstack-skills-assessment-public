import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    if (req.path === '/health') return;

    const processingTimeMs = Date.now() - startTime;

    // Same JSON line format as the other services. Never the API key or card data.
    const logEntry = {
      '@timestamp': new Date().toISOString(),
      level: res.statusCode >= 500 ? 'ERROR' : 'INFO',
      logger_name: 'middleware.requestLogger',
      message: `${req.method} u:${req.originalUrl} r:${res.statusCode} t:${processingTimeMs}ms`,
      ...withDefinedValues({
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
