import {
  createShutdownHandler,
  createUncaughtExceptionHandler,
  createUnhandledRejectionHandler,
  FORCED_EXIT_AFTER_MS,
} from './processGuards';

function loggedErrors(): Record<string, unknown>[] {
  return (console.error as jest.Mock).mock.calls.map(([line]) => JSON.parse(String(line)));
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('unhandledRejection', () => {
  it('logs an alertable error and keeps running', () => {
    createUnhandledRejectionHandler()(new Error('nobody awaited me'));

    expect(loggedErrors()).toEqual([
      expect.objectContaining({ level: 'ERROR', event: 'unhandled_rejection', message: expect.stringContaining('nobody awaited me') }),
    ]);
    // There is no server or exit to call: the handler can't stop the process
  });
});

describe('uncaughtException', () => {
  it('logs, stops accepting connections and exits non-zero once they have closed', () => {
    let closed: () => void = () => {};
    const server = { close: jest.fn((cb: () => void) => (closed = cb)) };
    const exit = jest.fn();
    const onException = createUncaughtExceptionHandler(server, exit);

    onException(new Error('boom'));

    expect(loggedErrors()[0]).toMatchObject({ event: 'uncaught_exception' });
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    closed();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('only starts shutting down once, but logs every error', () => {
    const server = { close: jest.fn() };
    const onException = createUncaughtExceptionHandler(server, jest.fn());

    onException(new Error('first'));
    onException(new Error('second'));

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(loggedErrors()).toHaveLength(2);
  });

  it('forces the exit if connections do not close in time', () => {
    jest.useFakeTimers();
    const exit = jest.fn();
    createUncaughtExceptionHandler({ close: jest.fn() }, exit)(new Error('stuck'));

    jest.advanceTimersByTime(FORCED_EXIT_AFTER_MS);

    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('SIGTERM / SIGINT', () => {
  it('exits 0 once connections have drained', () => {
    let closed: () => void = () => {};
    const exit = jest.fn();
    createShutdownHandler({ close: (cb: () => void) => (closed = cb) }, exit)();

    expect(exit).not.toHaveBeenCalled();
    closed();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces a non-zero exit if connections do not drain in time', () => {
    jest.useFakeTimers();
    const exit = jest.fn();
    createShutdownHandler({ close: jest.fn() }, exit)();

    jest.advanceTimersByTime(FORCED_EXIT_AFTER_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
