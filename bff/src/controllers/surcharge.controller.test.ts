import request from 'supertest';
import { Express } from 'express';

const API_KEY = 'sk_test_harbor_8d1e6b03c7';
const JPY_KEY = 'sk_test_sakura_6c2b7d9e11';
const EUR_KEY = 'sk_test_euro_1a2b3c4d5e';

const MERCHANTS: Record<string, { id: string; name: string; currency: string; surchargeRate: number }> = {
  [API_KEY]: { id: 'mer_002', name: 'Harbor Dental Group', currency: 'USD', surchargeRate: 2.5 },
  [JPY_KEY]: { id: 'mer_003', name: 'Sakura Ramen', currency: 'JPY', surchargeRate: 3 },
  [EUR_KEY]: { id: 'mer_009', name: 'Euro Test', currency: 'EUR', surchargeRate: 2 },
};

/** A signed quote as docs/quote-contract.md describes it (INC-4471's payment). */
const QUOTE = {
  merchantId: 'mer_002',
  currency: 'USD',
  network: 'VISA',
  cardType: 'CREDIT',
  surchargeable: true,
  rate: 2.5,
  amount: 185,
  surcharge: 4.63,
  total: 189.63,
  currencyExponent: 2,
  amountMinor: 18500,
  surchargeMinor: 463,
  totalMinor: 18963,
  reason: null,
  bin: '41111111',
  keyId: 'test-1',
  expiresAt: 1767225600,
  signature: '_eheNpSMYu68PGi9lBWW-VqEwKqvc2MkL8Sijse2LBU',
};

type Responder = (url: URL, opts: RequestInit) => Promise<Response>;

let app: Express;
let fetchMock: jest.Mock;
let paymentsApi: Responder;
let surchargeService: Responder;

function fetchResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** Never answers; rejects with the signal's reason when the timeout aborts it, like real fetch. */
function hangingFetch(_url: URL, opts: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason));
  });
}

function networkError(): Promise<Response> {
  return Promise.reject(
    new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND surcharge-service') }),
  );
}

async function merchantLookup(_url: URL, opts: RequestInit): Promise<Response> {
  const merchant = MERCHANTS[(opts.headers as Record<string, string>)['X-Api-Key']];
  return merchant ? fetchResponse(200, merchant) : fetchResponse(401, { error: 'Invalid API key' });
}

function quoteCalls() {
  return fetchMock.mock.calls.filter(([url]) => (url as URL).pathname === '/v1/quotes');
}

function quote(body: unknown, apiKey = API_KEY) {
  return request(app).post('/api/surcharge/quote').set('X-Api-Key', apiKey).send(body as object);
}

beforeEach(async () => {
  // fresh modules so the merchant cache starts empty
  jest.resetModules();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  paymentsApi = merchantLookup;
  surchargeService = async () => fetchResponse(200, QUOTE);
  fetchMock = jest.fn(async (url: URL, opts: RequestInit) =>
    url.pathname === '/api/merchants/me' ? paymentsApi(url, opts) : surchargeService(url, opts),
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  app = (await import('../app')).default;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/surcharge/quote', () => {
  it('asks the surcharge service to quote for the merchant behind the API key', async () => {
    await quote({ amount: 100, bin: '41111111' });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(String(url)).toBe('http://localhost:9000/v1/quotes');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ merchantId: 'mer_002', amount: 100, bin: '41111111' });
    expect((opts as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('returns every field of the quote except merchantId, including ones the BFF does not know', async () => {
    surchargeService = async () => fetchResponse(200, { ...QUOTE, futureField: { nested: [1, 2] } });

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(200);
    const { merchantId: _merchantId, ...expected } = QUOTE;
    expect(res.body).toEqual({ ...expected, futureField: { nested: [1, 2] } });
    expect(res.body.currency).toBe('USD');
    expect(res.body).not.toHaveProperty('merchantId');
  });

  it('passes an unsurcharged quote through with its reason', async () => {
    const notCredit = { ...QUOTE, cardType: 'DEBIT', surchargeable: false, rate: 0, surcharge: 0, total: 185, surchargeMinor: 0, totalMinor: 18500, reason: 'NOT_CREDIT' };
    surchargeService = async () => fetchResponse(200, notCredit);

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('NOT_CREDIT');
  });

  it('does not check enum values', async () => {
    surchargeService = async () => fetchResponse(200, { ...QUOTE, network: 'NEWNET', cardType: 'CHARGE' });

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.body.network).toBe('NEWNET');
    expect(res.body.cardType).toBe('CHARGE');
  });

  it('passes a quote through even for a currency the BFF has no exponent for', async () => {
    surchargeService = async () => fetchResponse(200, { ...QUOTE, merchantId: 'mer_009', currency: 'EUR' });

    const res = await quote({ amount: 185, bin: '41111111' }, EUR_KEY);

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('EUR');
  });

  it('looks the merchant up once per API key', async () => {
    await quote({ amount: 100, bin: '41111111' });
    await quote({ amount: 50, bin: '41111111' });

    const merchantLookups = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/merchants/me'));
    expect(merchantLookups).toHaveLength(1);
  });

  it.each([
    [{ amount: 0, bin: '41111111' }],
    [{ amount: -5, bin: '41111111' }],
    [{ amount: '100', bin: '41111111' }],
    [{ amount: 100, bin: '4111' }],
    [{ amount: 100, bin: '4111abcd' }],
    [{}],
  ])('returns 400 for %j without calling upstream', async (body) => {
    const res = await quote(body);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an amount that JSON parses to Infinity', async () => {
    const res = await request(app)
      .post('/api/surcharge/quote')
      .set('X-Api-Key', API_KEY)
      .set('Content-Type', 'application/json')
      .send('{"amount": 1e999, "bin": "41111111"}');

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fallback to "no surcharge"', () => {
  const { signature: _signature, ...unsigned } = QUOTE;
  const { reason: _reason, ...noReason } = QUOTE;

  it.each<[string, () => Responder, string]>([
    ['a network error', () => networkError, 'UNAVAILABLE'],
    ['a 500', () => async () => fetchResponse(500, { error: 'boom' }), 'UNAVAILABLE'],
    ['a 503 with an HTML body', () => async () => new Response('<html>503</html>', { status: 503 }), 'UNAVAILABLE'],
    ['an unexpected 415', () => async () => fetchResponse(415, { error: 'unsupported_media_type' }), 'UNAVAILABLE'],
    ['an unexpected 401', () => async () => fetchResponse(401, { error: 'unauthorized' }), 'UNAVAILABLE'],
    ['an unexpected 429', () => async () => fetchResponse(429, { error: 'slow_down' }), 'UNAVAILABLE'],
    ['a 200 that is not JSON', () => async () => new Response('not json', { status: 200 }), 'UNAVAILABLE'],
    ['a 200 with an empty body', () => async () => new Response('', { status: 200 }), 'UNAVAILABLE'],
    ['a 200 with a JSON array', () => async () => fetchResponse(200, [QUOTE]), 'UNAVAILABLE'],
    ['a quote with no signature', () => async () => fetchResponse(200, unsigned), 'UNAVAILABLE'],
    ['a quote with no reason field', () => async () => fetchResponse(200, noReason), 'UNAVAILABLE'],
    ['a quote with a null field other than reason', () => async () => fetchResponse(200, { ...QUOTE, keyId: null }), 'UNAVAILABLE'],
    ['a quote with a non-integer amountMinor', () => async () => fetchResponse(200, { ...QUOTE, amountMinor: 18500.5 }), 'UNAVAILABLE'],
    ['a quote with an unsafe-integer totalMinor', () => async () => fetchResponse(200, { ...QUOTE, totalMinor: 2 ** 53 }), 'UNAVAILABLE'],
    ['a quote with a string amount', () => async () => fetchResponse(200, { ...QUOTE, amount: '185' }), 'UNAVAILABLE'],
    [
      'an old-format quote (from before the contract)',
      () => async () =>
        fetchResponse(200, { merchantId: 'mer_002', currency: 'USD', network: 'VISA', cardType: 'CREDIT', surchargeable: true, rate: 2.5, amount: 185, surcharge: 4.63, total: 189.63 }),
      'UNAVAILABLE',
    ],
    ['a 404 (unknown merchant)', () => async () => fetchResponse(404, { error: 'unknown_merchant' }), 'UNKNOWN_MERCHANT'],
    ['a routing 404 with no JSON body', () => async () => new Response('Not Found', { status: 404 }), 'UNKNOWN_MERCHANT'],
  ])('falls back on %s with reason %s', async (_name, responder, reason) => {
    surchargeService = responder();

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe(reason);
    expect(res.body.surchargeable).toBe(false);
  });

  it('falls back with TIMEOUT when the service does not answer in time', async () => {
    (await import('../config')).config.surchargeQuoteTimeoutMs = 50;
    surchargeService = hangingFetch;

    const started = Date.now();
    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns the exact fallback shape, with no signature fields', async () => {
    surchargeService = networkError;

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.body).toEqual({
      currency: 'USD',
      network: 'UNKNOWN',
      cardType: 'UNKNOWN',
      surchargeable: false,
      rate: 0,
      amount: 185,
      surcharge: 0,
      total: 185,
      currencyExponent: 2,
      amountMinor: 18500,
      surchargeMinor: 0,
      totalMinor: 18500,
      reason: 'UNAVAILABLE',
      bin: '41111111',
    });
  });

  it.each([
    [185, 18500],
    [1.15, 115], // 1.15 * 100 is 114.99999999999999 in floating point
    [0.29, 29],
    [10.1, 1010],
  ])('works out amountMinor for USD %p as %p', async (amount, minor) => {
    surchargeService = networkError;

    const res = await quote({ amount, bin: '41111111' });

    expect(res.status).toBe(200);
    expect(res.body.amountMinor).toBe(minor);
    expect(res.body.totalMinor).toBe(minor);
    expect(res.body.amount).toBe(amount);
  });

  it('uses exponent 0 for JPY', async () => {
    surchargeService = networkError;

    const res = await quote({ amount: 1234, bin: '41111111' }, JPY_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currency: 'JPY', currencyExponent: 0, amount: 1234, amountMinor: 1234, totalMinor: 1234 });
  });

  it.each([
    ['USD', API_KEY, 10.001],
    ['USD', API_KEY, 0.1 + 0.2], // 0.30000000000000004 is not exactly 30 cents
    ['JPY', JPY_KEY, 100.5],
    ['USD', API_KEY, 1e14], // valid decimals, but 1e16 minor units is past 2^53 - 1
    ['JPY', JPY_KEY, 2 ** 53],
  ])('returns 422 invalid_amount for a %s amount of %p', async (_currency, key, amount) => {
    surchargeService = networkError;

    const res = await quote({ amount, bin: '41111111' }, key);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'invalid_amount' });
  });

  it.each([
    ['a 422 for the amount', API_KEY, 10.001, 422],
    ['a 500 for an unknown currency', EUR_KEY, 185, 500],
  ])('does not count %s as a fallback', async (_name, key, amount, status) => {
    surchargeService = networkError;

    const res = await quote({ amount, bin: '41111111' }, key);

    expect(res.status).toBe(status);
    const lines = JSON.stringify([(console.log as jest.Mock).mock.calls, (console.error as jest.Mock).mock.calls]);
    expect(lines).not.toContain('surcharge_fallback');
    expect(lines).not.toContain('Surcharge quote fallback');
  });

  it('returns 500 and logs a config fault for a currency with no known exponent', async () => {
    surchargeService = networkError;

    const res = await quote({ amount: 185, bin: '41111111' }, EUR_KEY);

    expect(res.status).toBe(500);
    const errors = JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(errors).toContain('Config fault: no currency exponent for EUR');
  });

  it('logs the fallback reason and the merchant', async () => {
    surchargeService = async () => fetchResponse(404, { error: 'unknown_merchant' });

    await quote({ amount: 185, bin: '41111111' });

    const requestLog = (console.log as jest.Mock).mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .find((entry) => entry.logger_name === 'middleware.requestLogger');
    expect(requestLog).toMatchObject({ merchant_id: 'mer_002', surcharge_fallback: 'UNKNOWN_MERCHANT' });
  });
});

describe('passed through, not a fallback', () => {
  it.each([
    [400, { error: 'invalid_bin', details: { bin: 'too short' } }, { error: 'invalid_bin' }],
    [422, { error: 'invalid_amount', details: 'JPY has no decimals' }, { error: 'invalid_amount' }],
    [400, 'not json', { error: 'invalid_request' }],
  ])('passes a %p through with the status only', async (status, body, expected) => {
    surchargeService = async () =>
      typeof body === 'string' ? new Response(body, { status }) : fetchResponse(status, body);

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(status);
    expect(res.body).toEqual(expected);
  });
});

describe('when the merchant lookup fails', () => {
  it('returns 401 for an invalid key without asking the surcharge service', async () => {
    const res = await quote({ amount: 185, bin: '41111111' }, 'sk_test_unknown_000');

    expect(res.status).toBe(401);
    expect(quoteCalls()).toHaveLength(0);
  });

  it.each<[string, () => Responder]>([
    ['a 500', () => async () => fetchResponse(500, { error: 'boom' })],
    ['a 503', () => async () => fetchResponse(503, { error: 'unavailable' })],
    ['a 403', () => async () => fetchResponse(403, { error: 'forbidden' })],
    ['a network error', () => networkError],
    ['a body that is not JSON', () => async () => new Response('<html>bad gateway</html>', { status: 200 })],
  ])('returns 502 upstream_error on %s', async (_name, responder) => {
    paymentsApi = responder();

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_error' });
    expect(quoteCalls()).toHaveLength(0);
  });

  it('returns 502 upstream_error when the lookup times out', async () => {
    (await import('../config')).config.paymentsApiTimeoutMs = 50;
    paymentsApi = hangingFetch;

    const res = await quote({ amount: 185, bin: '41111111' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_error' });
  });
});
