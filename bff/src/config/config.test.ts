import { positiveIntFromEnv } from '.';

const NAME = 'BFF_TEST_POSITIVE_INT';

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[NAME];
  jest.restoreAllMocks();
});

describe('positiveIntFromEnv', () => {
  it('uses the default, quietly, when unset or empty', () => {
    expect(positiveIntFromEnv(NAME, 1500)).toBe(1500);
    process.env[NAME] = '  ';
    expect(positiveIntFromEnv(NAME, 1500)).toBe(1500);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('reads a positive whole number', () => {
    process.env[NAME] = ' 2500 ';
    expect(positiveIntFromEnv(NAME, 1500)).toBe(2500);
  });

  it.each(['30s', '1.5', '0', '-5', 'abc', '1e400', '0x10z'])('rejects %p with a WARN and uses the default', (raw) => {
    process.env[NAME] = raw;

    expect(positiveIntFromEnv(NAME, 1500)).toBe(1500);
    const warning = JSON.parse(String((console.log as jest.Mock).mock.calls[0][0]));
    expect(warning).toMatchObject({ level: 'WARN', logger_name: 'config' });
    expect(warning.message).toContain(NAME);
  });
});
