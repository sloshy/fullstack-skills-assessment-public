import request from 'supertest';
import { Express, NextFunction, Request, Response as ExpressResponse } from 'express';

// INC-4493: one failed upstream call used to reject inside an unwrapped async handler and take
// the whole process down. Every route must answer with an error instead.

const API_KEY = 'sk_test_harbor_8d1e6b03c7';
const HARBOR = { id: 'mer_002', name: 'Harbor Dental Group', currency: 'USD', surchargeRate: 2.5 };

type Route = [method: 'get' | 'post', path: string, body?: object];

/** [route, status for a 200 whose body isn't JSON]. */
// A write that got a 2xx went through, so its outcome is unknown rather than an upstream error.
const ROUTES: [...Route, number][] = [
  ['get', '/api/merchants/me', undefined, 502],
  ['get', '/api/payments?page=1', undefined, 502],
  ['post', '/api/payments', { amount: 10, cardNumber: '4111111111111111' }, 504],
  ['get', '/api/payments/pay_1', undefined, 502],
  ['post', '/api/payments/pay_1/refund', {}, 504],
  ['post', '/api/surcharge/quote', { amount: 185, bin: '41111111' }, 502],
];

let app: Express;
let fetchMock: jest.Mock;
const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => unhandled.push(reason);

function fetchResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function send([method, path, body]: Route) {
  const req = request(app)[method](path).set('X-Api-Key', API_KEY);
  return body ? req.send(body) : req;
}

/** Lets any stray rejection from the request surface before we check for it. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(() => {
  process.on('unhandledRejection', recordUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', recordUnhandled);
});

beforeEach(async () => {
  jest.resetModules();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  unhandled.length = 0;

  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;

  app = (await import('./app')).default;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(ROUTES)('%s %s', (method, path, body, nonJsonStatus) => {
  const route: Route = [method, path, body];

  it('answers 502 when every upstream is unreachable (ENOTFOUND)', async () => {
    // Shaped like undici's: the DNS error, with its code, is the cause
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND upstream'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' });
    fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: dnsError }));

    const res = await send(route);
    await settle();

    expect(res.status).toBe(502);
    expect(unhandled).toEqual([]);
  });

  it('answers 401 when the payments API rejects the key', async () => {
    fetchMock.mockImplementation(async () => fetchResponse(401, { error: 'Invalid API key' }));

    const res = await send(route);
    await settle();

    expect(res.status).toBe(401);
    expect(unhandled).toEqual([]);
  });

  it(`answers ${nonJsonStatus} when an upstream body is not JSON`, async () => {
    fetchMock.mockImplementation(async () => new Response('<html>Bad Gateway</html>', { status: 200 }));

    const res = await send(route);
    await settle();

    expect(res.status).toBe(nonJsonStatus);
    expect(unhandled).toEqual([]);
  });

  it('keeps serving other requests afterwards', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await send(route);

    fetchMock.mockImplementation(async () => fetchResponse(200, HARBOR));
    const res = await request(app).get('/api/merchants/me').set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
  });
});

describe('the surcharge service failing on its own', () => {
  it.each<[string, () => Promise<Response>]>([
    ['the fetch rejects', () => Promise.reject(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND surcharge-service') }))],
    ['the body is not JSON', async () => new Response('<html>oops</html>', { status: 200 })],
  ])('falls back instead of crashing when %s', async (_name, surcharge) => {
    fetchMock.mockImplementation(async (url: URL) => (url.pathname === '/api/merchants/me' ? fetchResponse(200, HARBOR) : surcharge()));

    const res = await send(['post', '/api/surcharge/quote', { amount: 185, bin: '41111111' }]);
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('UNAVAILABLE');
    expect(unhandled).toEqual([]);
  });
});

describe('errorHandler', () => {
  it('hands over to Express when the response has already started', async () => {
    const { errorHandler } = await import('./middleware/errorHandler');
    const res = { headersSent: true, status: jest.fn(), json: jest.fn() } as unknown as ExpressResponse;
    const next = jest.fn() as NextFunction;
    const err = new Error('late failure');

    errorHandler(err, { method: 'GET', baseUrl: '/api/payments', path: '/', originalUrl: '/api/payments' } as Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('logs the route, status and error but not the API key', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await request(app).get('/api/payments/pay_1').set('X-Api-Key', API_KEY);

    const errorLog = (console.log as jest.Mock).mock.calls
      .concat((console.error as jest.Mock).mock.calls)
      .map(([line]) => String(line))
      .find((line) => line.includes('middleware.errorHandler'));
    expect(JSON.parse(errorLog!)).toMatchObject({ route: 'GET /api/payments/pay_1', status: 502 });
    expect(errorLog).not.toContain(API_KEY);
  });

  it('answers malformed JSON with a fixed 400 and never echoes or logs the body', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('X-Api-Key', API_KEY)
      .set('Content-Type', 'application/json')
      .send('{"amount": 10, "cardNumber": "4000000000000259" oops');
    await settle();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
    expect(res.text).not.toContain('4000000000000259');
    const logs = JSON.stringify([(console.log as jest.Mock).mock.calls, (console.error as jest.Mock).mock.calls]);
    expect(logs).not.toContain('4000000000000259');
    expect(logs).toContain('entity.parse.failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
