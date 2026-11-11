import request from 'supertest';
import { Express } from 'express';

const HARBOR_KEY = 'sk_test_harbor_8d1e6b03c7';
const COASTAL_KEY = 'sk_test_coastal_51f0a9e2d4';
/** Another key for the same merchant. */
const HARBOR_SECOND_KEY = 'sk_test_harbor_frontdesk_2';
const BAD_KEY = 'sk_test_revoked_0000000000';

const HARBOR = { id: 'mer_002', name: 'Harbor Dental Group', currency: 'USD', surchargeRate: 2.5 };
const MERCHANTS: Record<string, { id: string; name: string; currency: string; surchargeRate: number }> = {
  [HARBOR_KEY]: HARBOR,
  [HARBOR_SECOND_KEY]: HARBOR,
  [COASTAL_KEY]: { id: 'mer_001', name: 'Coastal Coffee', currency: 'USD', surchargeRate: 3 },
};

/** Each merchant's own page, so a leak shows up as the wrong merchant's items. */
function pageFor(merchantId: string) {
  return { items: [{ id: `pay_${merchantId}`, merchantId }], page: 1, pageSize: 25, totalCount: 1 };
}

let app: Express;
let fetchMock: jest.Mock;
let createStatus: number;
let refundStatus: number;

function fetchResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function apiKeyOf(opts: RequestInit | undefined): string {
  return ((opts?.headers ?? {}) as Record<string, string>)['X-Api-Key'];
}

/**
 * A payments API that knows two keys, answers 401 for anything else, and serves each
 * merchant only its own payments.
 */
async function fakePaymentsApi(url: URL, opts?: RequestInit): Promise<Response> {
  const merchant = MERCHANTS[apiKeyOf(opts)];
  if (!merchant) return fetchResponse(401, { error: 'Invalid API key' });

  const method = opts?.method ?? 'GET';
  if (url.pathname === '/api/merchants/me') return fetchResponse(200, merchant);
  if (url.pathname === '/api/payments' && method === 'GET') return fetchResponse(200, pageFor(merchant.id));
  if (url.pathname === '/api/payments' && method === 'POST') return fetchResponse(createStatus, { id: 'pay_new' });
  if (url.pathname.endsWith('/refund')) return fetchResponse(refundStatus, { id: 'pay_1', status: 'REFUNDED' });
  return fetchResponse(404, { title: 'Not Found', status: 404 });
}

function listCalls(apiKey?: string) {
  return fetchMock.mock.calls.filter(
    ([url, opts]) =>
      (url as URL).pathname === '/api/payments' &&
      ((opts as RequestInit | undefined)?.method ?? 'GET') === 'GET' &&
      (apiKey === undefined || apiKeyOf(opts as RequestInit) === apiKey),
  );
}

function requestLogs(): Record<string, unknown>[] {
  return (console.log as jest.Mock).mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((entry) => entry.logger_name === 'middleware.requestLogger');
}

beforeEach(async () => {
  // fresh modules so the list and merchant caches start empty
  jest.resetModules();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  createStatus = 201;
  refundStatus = 200;
  fetchMock = jest.fn(fakePaymentsApi);
  global.fetch = fetchMock as unknown as typeof fetch;

  app = (await import('../app')).default;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/payments', () => {
  it('returns 401 when the API key is missing', async () => {
    const res = await request(app).get('/api/payments');

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the API key and query string to the payments API', async () => {
    const res = await request(app).get('/api/payments?page=2&pageSize=10').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(200);
    const [url, opts] = listCalls()[0];
    expect(String(url)).toBe('http://localhost:5080/api/payments?page=2&pageSize=10');
    expect(apiKeyOf(opts as RequestInit)).toBe(HARBOR_KEY);
  });

  it('serves a repeat request from the cache', async () => {
    await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);
    const res = await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);

    expect(res.body).toEqual(pageFor('mer_002'));
    expect(listCalls()).toHaveLength(1);
  });

  it('treats the same parameters in a different order as the same page', async () => {
    await request(app).get('/api/payments?pageSize=10&page=2').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments?page=2&pageSize=10').set('X-Api-Key', HARBOR_KEY);

    expect(listCalls()).toHaveLength(1);
  });

  it('forwards only page and pageSize, so junk parameters cannot create new cache entries', async () => {
    await request(app).get('/api/payments?page=2&cacheBust=1&pageSize=10').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments?page=2&pageSize=10&cacheBust=2&x=y').set('X-Api-Key', HARBOR_KEY);

    expect(listCalls()).toHaveLength(1);
    expect(String(listCalls()[0][0])).toBe('http://localhost:5080/api/payments?page=2&pageSize=10');
  });

  it('does not share an entry between two keys of the same merchant', async () => {
    await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);
    const res = await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_SECOND_KEY);

    expect(res.body).toEqual(pageFor('mer_002'));
    expect(listCalls(HARBOR_KEY)).toHaveLength(1);
    expect(listCalls(HARBOR_SECOND_KEY)).toHaveLength(1);
  });

  it("a write through one key clears the merchant's entries for every key", async () => {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_SECOND_KEY);

    await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_SECOND_KEY);

    expect(listCalls(HARBOR_SECOND_KEY)).toHaveLength(2);
  });

  it('gives two merchants requesting the same URL their own payments (INC-4486)', async () => {
    const harbor = await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);
    const coastal = await request(app).get('/api/payments?page=1').set('X-Api-Key', COASTAL_KEY);
    const harborAgain = await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);

    expect(harbor.body).toEqual(pageFor('mer_002'));
    expect(coastal.body).toEqual(pageFor('mer_001'));
    expect(harborAgain.body).toEqual(pageFor('mer_002'));
    expect(listCalls(HARBOR_KEY)).toHaveLength(1);
    expect(listCalls(COASTAL_KEY)).toHaveLength(1);
  });

  it("gives an invalid key the payments API's 401, not a page another merchant cached", async () => {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

    const res = await request(app).get('/api/payments').set('X-Api-Key', BAD_KEY);

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('mer_002');
  });

  it('does not cache an error response', async () => {
    fetchMock.mockImplementation(async (url: URL, opts?: RequestInit) =>
      url.pathname === '/api/payments' ? fetchResponse(503, { error: 'busy' }) : fakePaymentsApi(url, opts),
    );
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    fetchMock.mockImplementation(fakePaymentsApi);

    const res = await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(200);
    expect(listCalls()).toHaveLength(2);
  });

  it('logs the merchant and whether the list came from the cache, never the API key', async () => {
    await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments?page=1').set('X-Api-Key', HARBOR_KEY);

    const logs = requestLogs();
    expect(logs.map((entry) => [entry.merchant_id, entry.cache])).toEqual([
      ['mer_002', 'miss'],
      ['mer_002', 'hit'],
    ]);
    const everything = JSON.stringify([(console.log as jest.Mock).mock.calls, (console.error as jest.Mock).mock.calls]);
    expect(everything).not.toContain(HARBOR_KEY);
  });
});

describe('cache invalidation', () => {
  async function fillBothMerchants() {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments').set('X-Api-Key', COASTAL_KEY);
  }

  async function refetchBothMerchants() {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments').set('X-Api-Key', COASTAL_KEY);
  }

  it("a successful create clears only that merchant's cached lists", async () => {
    await fillBothMerchants();

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
    await refetchBothMerchants();

    expect(res.status).toBe(201);
    expect(listCalls(HARBOR_KEY)).toHaveLength(2);
    expect(listCalls(COASTAL_KEY)).toHaveLength(1);
  });

  it('a failed create clears nothing', async () => {
    createStatus = 400;
    await fillBothMerchants();

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: -1 });
    await refetchBothMerchants();

    expect(res.status).toBe(400);
    expect(listCalls(HARBOR_KEY)).toHaveLength(1);
    expect(listCalls(COASTAL_KEY)).toHaveLength(1);
  });

  it("a successful refund clears only that merchant's cached lists", async () => {
    await fillBothMerchants();

    const res = await request(app).post('/api/payments/pay_1/refund').set('X-Api-Key', HARBOR_KEY).send({});
    await refetchBothMerchants();

    expect(res.status).toBe(200);
    expect(listCalls(HARBOR_KEY)).toHaveLength(2);
    expect(listCalls(COASTAL_KEY)).toHaveLength(1);
  });

  it('a failed refund clears nothing', async () => {
    refundStatus = 409;
    await fillBothMerchants();

    const res = await request(app).post('/api/payments/pay_1/refund').set('X-Api-Key', HARBOR_KEY).send({});
    await refetchBothMerchants();

    expect(res.status).toBe(409);
    expect(listCalls(HARBOR_KEY)).toHaveLength(1);
    expect(listCalls(COASTAL_KEY)).toHaveLength(1);
  });

  it('a create with a bad key clears nothing', async () => {
    await fillBothMerchants();

    const res = await request(app).post('/api/payments').set('X-Api-Key', BAD_KEY).send({ amount: 10 });
    await refetchBothMerchants();

    expect(res.status).toBe(401);
    expect(listCalls()).toHaveLength(2);
  });
});

describe('write timeouts (charges are not cancelled upstream)', () => {
  /** Answers after delayMs, or rejects with the signal's reason if the timeout fires first. */
  function slowCreate(delayMs: number, status = 201) {
    return (url: URL, opts?: RequestInit): Promise<Response> => {
      if (!(url.pathname === '/api/payments' && opts?.method === 'POST')) return fakePaymentsApi(url, opts);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(fetchResponse(status, { id: 'pay_slow' })), delayMs);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(opts.signal?.reason);
        });
      });
    };
  }

  async function setTimeouts(readMs: number, writeMs: number) {
    const { config } = await import('../config');
    config.paymentsApiTimeoutMs = readMs;
    config.paymentsApiWriteTimeoutMs = writeMs;
  }

  it('lets a create run longer than the read timeout', async () => {
    await setTimeouts(50, 1000);
    fetchMock.mockImplementation(slowCreate(200));

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'pay_slow' });
  });

  it('returns 504 payment_outcome_unknown when a create passes the write timeout, and still invalidates', async () => {
    await setTimeouts(50, 100);
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments').set('X-Api-Key', COASTAL_KEY);
    fetchMock.mockImplementation(slowCreate(5000));

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
    fetchMock.mockImplementation(fakePaymentsApi);
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    await request(app).get('/api/payments').set('X-Api-Key', COASTAL_KEY);

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'payment_outcome_unknown' });
    expect(listCalls(HARBOR_KEY)).toHaveLength(2);
    expect(listCalls(COASTAL_KEY)).toHaveLength(1);
  });

  it('returns 504 payment_outcome_unknown when the connection drops after a refund was sent', async () => {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    fetchMock.mockImplementation(async (url: URL, opts?: RequestInit) =>
      url.pathname.endsWith('/refund')
        ? Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))
        : fakePaymentsApi(url, opts),
    );

    const res = await request(app).post('/api/payments/pay_1/refund').set('X-Api-Key', HARBOR_KEY).send({});
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'payment_outcome_unknown' });
    expect(listCalls(HARBOR_KEY)).toHaveLength(2);
  });

  /** Shaped like Node's system errors, which fetch puts in `cause`. */
  function systemError(code: string, syscall: string) {
    return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
  }

  function createRejectsWith(cause: unknown) {
    fetchMock.mockImplementation(async (url: URL, opts?: RequestInit) =>
      url.pathname === '/api/payments' && opts?.method === 'POST'
        ? Promise.reject(new TypeError('fetch failed', { cause }))
        : fakePaymentsApi(url, opts),
    );
  }

  it.each<[string, () => unknown]>([
    ['DNS failure (getaddrinfo ENOTFOUND)', () => systemError('ENOTFOUND', 'getaddrinfo')],
    ['connection refused (connect ECONNREFUSED)', () => systemError('ECONNREFUSED', 'connect')],
    ['no route while connecting (connect EHOSTUNREACH)', () => systemError('EHOSTUNREACH', 'connect')],
    [
      'every address refused (AggregateError of connect errors)',
      () => new AggregateError([systemError('ECONNREFUSED', 'connect'), systemError('ENETUNREACH', 'connect')]),
    ],
  ])('returns 502 for a create that cannot have been sent: %s', async (_name, cause) => {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    createRejectsWith(cause());

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
    fetchMock.mockImplementation(fakePaymentsApi);
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_error' });
    expect(listCalls(HARBOR_KEY)).toHaveLength(1); // nothing happened, nothing to invalidate
  });

  it.each<[string, () => unknown]>([
    ['EHOSTUNREACH on an established socket (syscall read)', () => systemError('EHOSTUNREACH', 'read')],
    ['ENETUNREACH on an established socket (syscall write)', () => systemError('ENETUNREACH', 'write')],
    ['a connection reset (read ECONNRESET)', () => systemError('ECONNRESET', 'read')],
    ['a not-sent code with no syscall', () => Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    [
      'an AggregateError where one attempt failed after connecting',
      () => new AggregateError([systemError('ECONNREFUSED', 'connect'), systemError('EHOSTUNREACH', 'read')]),
    ],
  ])('returns 504 payment_outcome_unknown for %s', async (_name, cause) => {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    createRejectsWith(cause());

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
    fetchMock.mockImplementation(fakePaymentsApi);
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'payment_outcome_unknown' });
    expect(listCalls(HARBOR_KEY)).toHaveLength(2);
  });

  it.each([502, 503, 504])(
    'returns 504 payment_outcome_unknown and invalidates for a gateway %p page that is not JSON',
    async (status) => {
      await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
      fetchMock.mockImplementation(async (url: URL, opts?: RequestInit) =>
        url.pathname === '/api/payments' && opts?.method === 'POST'
          ? new Response('<html>Gateway error</html>', { status })
          : fakePaymentsApi(url, opts),
      );

      const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
      fetchMock.mockImplementation(fakePaymentsApi);
      await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: 'payment_outcome_unknown' });
      expect(listCalls(HARBOR_KEY)).toHaveLength(2);
    },
  );

  it.each([500, 400, 429])('returns 502 and keeps the cache for a non-JSON %p from a write', async (status) => {
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);
    fetchMock.mockImplementation(async (url: URL, opts?: RequestInit) =>
      url.pathname === '/api/payments' && opts?.method === 'POST'
        ? new Response('<html>error</html>', { status })
        : fakePaymentsApi(url, opts),
    );

    const res = await request(app).post('/api/payments').set('X-Api-Key', HARBOR_KEY).send({ amount: 10 });
    fetchMock.mockImplementation(fakePaymentsApi);
    await request(app).get('/api/payments').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_error' });
    expect(listCalls(HARBOR_KEY)).toHaveLength(1);
  });

  it('keeps the read timeout for GETs', async () => {
    await setTimeouts(50, 5000);
    fetchMock.mockImplementation((url: URL, opts?: RequestInit) =>
      url.pathname === '/api/merchants/me'
        ? fakePaymentsApi(url, opts)
        : new Promise<Response>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason));
          }),
    );

    const started = Date.now();
    const res = await request(app).get('/api/payments/pay_1').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('payment ids', () => {
  it.each([
    ['get', '/api/payments/%2E'],
    ['get', '/api/payments/%2E%2E'],
    ['post', '/api/payments/%2E/refund'],
    ['post', '/api/payments/%2E%2E/refund'],
  ] as const)('rejects %s %s with 400 before proxying', async (method, path) => {
    const res = await request(app)[method](path).set('X-Api-Key', HARBOR_KEY).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payment_id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still encodes other ids', async () => {
    await request(app).get('/api/payments/pay%2F1%3Fx').set('X-Api-Key', HARBOR_KEY);

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:5080/api/payments/pay%2F1%3Fx');
  });
});

describe('GET /api/payments/:id', () => {
  it('passes a 404 from the payments API through', async () => {
    const res = await request(app).get('/api/payments/pay_missing').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(404);
  });

  it('returns 502 when the payments API is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await request(app).get('/api/payments/pay_1').set('X-Api-Key', HARBOR_KEY);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_error' });
  });
});
