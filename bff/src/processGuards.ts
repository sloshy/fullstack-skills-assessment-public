import { describeError, logEvent } from './logger';

interface Closable {
  close(callback: () => void): unknown;
}

type Exit = (code: number) => void;

export const FORCED_EXIT_AFTER_MS = 10_000;

// Stop taking new connections, let in-flight requests finish, then exit. If connections
// don't drain in time, exit anyway.
function closeThenExit(server: Closable, exit: Exit, code: number): void {
  setTimeout(() => exit(code === 0 ? 1 : code), FORCED_EXIT_AFTER_MS).unref();
  server.close(() => exit(code));
}

// unhandledRejection: log and keep running. Every route handler is wrapped (asyncHandler), so
// a rejection here is a promise nobody awaited, not a broken request. Exiting would turn one
// forgotten wrapper into INC-4493 again (every terminal down). The event field is for alerting.
export function createUnhandledRejectionHandler() {
  return (reason: unknown): void => {
    logEvent('ERROR', 'processGuards', `Unhandled promise rejection: ${describeError(reason)}`, {
      event: 'unhandled_rejection',
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
}

// uncaughtException: the process state can't be trusted after a synchronous throw escaped,
// so log it, drain and exit non-zero so the orchestrator restarts us.
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

// SIGTERM / SIGINT: graceful, but bounded, so a hung connection can't block a deploy
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
