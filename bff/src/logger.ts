// Same JSON line format as the other services. Never pass API keys or card data in here.
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export function logEvent(level: LogLevel, loggerName: string, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    '@timestamp': new Date().toISOString(),
    level,
    logger_name: loggerName,
    message,
    ...fields,
  });
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Error name and message plus its cause (fetch puts the useful part, e.g. ENOTFOUND, in the cause)
// (duck-typed: a DOMException or an error from another realm isn't always instanceof Error)
export function describeError(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; cause?: { message?: unknown } } | null;
  if (typeof e?.message !== 'string') return String(err);
  const causeText = typeof e.cause?.message === 'string' ? ` (cause: ${e.cause.message})` : '';
  return `${String(e.name ?? 'Error')}: ${e.message}${causeText}`;
}
