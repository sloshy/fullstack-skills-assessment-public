import { describeError, logEvent } from './logger';

interface Closable {
  close(callback: () => void): unknown;
}

type Exit = (code: number) => void;

export const FORCED_EXIT_AFTER_MS = 10_000;

/**
 * Stops taking new connections, lets in-flight requests finish, then exits. If connections
 * don't drain within {@link FORCED_EXIT_AFTER_MS}, exits anyway.
 */
function closeThenExit(server: Closable, exit: Exit, code: number): void {
  setTimeout(() => exit(code === 0 ? 1 : code), FORCED_EXIT_AFTER_MS).unref();
  server.close(() => exit(code));
}

/** Creates the unhandledRejection handler: log and keep running. */
// Every route handler is wrapped (asyncHandler), so a rejection here is a promise nobody
// awaited, not a broken request. Exiting would turn one forgotten wrapper into INC-4493 again
// (every terminal down).
export function createUnhandledRejectionHandler() {
  return (reason: unknown): void => {
    logEvent('ERROR', 'processGuards', `Unhandled promise rejection: ${describeError(reason)}`, {
      // The event field is for alerting
      event: 'unhandled_rejection',
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
}

/**
 * Creates the uncaughtException handler: log it, drain and exit non-zero so the orchestrator
 * restarts us.
 */
// The process state can't be trusted after a synchronous throw escaped.
export function createUncaughtExceptionHandler(server: Closable, exit: Exit = process.exit) {
  let shuttingDown = false;

  return (err: unknown): void => {
    logEvent('ERROR', 'processGuards', `Uncaught exception: ${describeError(err)}`, {
      event: 'uncaught_exception',
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (shuttingDown) return;
    shuttingDown = true;
    closeThenExit(server, exit, 1);
  };
}

/** Creates the SIGTERM / SIGINT handler: graceful, but bounded. */
// Bounded so a hung connection can't block a deploy.
export function createShutdownHandler(server: Closable, exit: Exit = process.exit) {
  let shuttingDown = false;

  return (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('INFO', 'processGuards', 'Shutting down');
    closeThenExit(server, exit, 0);
  };
}

export function installProcessGuards(server: Closable): void {
  process.on('unhandledRejection', createUnhandledRejectionHandler());
  process.on('uncaughtException', createUncaughtExceptionHandler(server));

  const shutdown = createShutdownHandler(server);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
