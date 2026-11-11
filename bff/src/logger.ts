/** Log level of a {@link logEvent} line. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * Writes one log line in the same JSON line format as the other services
 * (ERROR to stderr, everything else to stdout). Never pass API keys or card data in here.
 */
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

/**
 * Describes an error as its name and message plus its cause (fetch puts the useful part,
 * e.g. ENOTFOUND, in the cause).
 */
export function describeError(err: unknown): string {
  // Duck-typed: a DOMException or an error from another realm isn't always instanceof Error
  const e = err as { name?: unknown; message?: unknown; cause?: { message?: unknown } } | null;
  if (typeof e?.message !== 'string') return String(err);
  const causeText = typeof e.cause?.message === 'string' ? ` (cause: ${e.cause.message})` : '';
  return `${String(e.name ?? 'Error')}: ${e.message}${causeText}`;
}
