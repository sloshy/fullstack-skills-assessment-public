# InterPayments Senior Fullstack Skills Assessment

A virtual terminal for taking card payments: a React app, a BFF in front of it,
and two backend services.

**Candidates:** start with [INSTRUCTIONS.md](./INSTRUCTIONS.md).

```
web ---/api---> bff ---/api---> payments-api ---> simulated card gateway
:5173           :3001 |         :5080 |           (in-process)
                      |               |
         preview quote|               |quote
                      v               v
                    surcharge-service :9000
```

| Service | |
| --- | --- |
| `web/` | React, Vite, antd. The terminal: list payments, take a payment, view a receipt, refund. |
| `bff/` | Node, Express, TypeScript. Passes the merchant's API key through to the payments API and gets preview quotes from the surcharge service. |
| `payments-api/` | .NET 10, EF Core, SQLite. Works out the merchant from `X-Api-Key`, gets a surcharge quote, charges the card through the gateway and saves the payment. The database is reset from seed data on every start. |
| `surcharge-service/` | Scala 2.13, Play 3. Looks the card up in the BIN table and applies the merchant's surcharge settings. |

The surcharging rules are in [docs/surcharging.md](./docs/surcharging.md).

## Prerequisites

- Docker
- Node 20+ for `web/` and `bff/` (`.nvmrc` says 22)
- .NET 10 SDK if you're working on `payments-api/`
- JDK 17+ (21 recommended) and [sbt](https://www.scala-sbt.org/download/) if
  you're working on `surcharge-service/`

## Quick start

```bash
docker compose up --build        # the first build takes a few minutes
```

Then open http://localhost:5173.

## Working on it

Run what you're changing locally and the rest in Docker. Everything looks for
the other services on `localhost` by default, and the containers can reach your
machine on `host.docker.internal`. Either way it's four terminals, and the UI is
the last one.

**.NET track:** the surcharge service in Docker, everything else locally.

```bash
# 1
docker compose up --build surcharge-service

# 2
cd payments-api
dotnet run --project src/InterPayments.Payments.Web.Api    # http://localhost:5080

# 3
cd bff
npm install
npm run dev                      # http://localhost:3001, restarts on change

# 4
cd web
npm install
npm run dev                      # http://localhost:5173, proxies /api to the BFF on :3001
```

**Scala track:** the payments API in Docker, everything else locally.

```bash
# 1
SURCHARGE_SERVICE_URL=http://host.docker.internal:9000/ docker compose up --build --no-deps payments-api

# 2
cd surcharge-service
sbt run                          # http://localhost:9000, dev mode, reloads on change

# 3
cd bff
npm install
npm run dev                      # http://localhost:3001, restarts on change

# 4
cd web
npm install
npm run dev                      # http://localhost:5173, proxies /api to the BFF on :3001
```

Then open http://localhost:5173.

`sbt run` is Play's dev mode. It compiles on the first request, so open
http://localhost:9000/health once before using the terminal, or the first quote
will time out. It's also slow, so use `sbt runProd` when you're measuring
performance.

## Merchants

Pick the merchant from the dropdown in the terminal's header. To call the APIs
directly, put one of these in the `X-Api-Key` header:

| Merchant | ID | Currency | Surcharge | API key |
| --- | --- | --- | --- | --- |
| Blue Ridge Outfitters | `mer_001` | USD | 3% | `sk_test_blueridge_4f9c2a71e0` |
| Harbor Dental Group | `mer_002` | USD | 2.5% | `sk_test_harbor_8d1e6b03c7` |
| Sakura Imports | `mer_003` | JPY | 3% | `sk_test_sakura_2b7f9e4415` |
| Lakeside Community Theatre | `mer_004` | USD | none | `sk_test_lakeside_c05a1d98b2` |

## Test cards

Any future expiry date and any CVV.

| Card number | |
| --- | --- |
| `4111 1111 1111 1111` | Visa credit |
| `4000 0566 5566 5556` | Visa debit |
| `4847 1800 0000 0009` | Visa prepaid |
| `5555 5555 5555 4444` | Mastercard credit |
| `5200 8282 8282 8210` | Mastercard debit |
| `3782 822463 10005` | Amex credit |
| `6011 1111 1111 1117` | Discover credit |
| `6390 0000 0000 0005` | Not in the BIN table |
| `4000 0000 0000 0002` | Visa credit, declined by the gateway |
| `4000 0000 0000 0259` | Visa credit, the gateway takes about 5 seconds |

## Commands

| Where | Command | |
| --- | --- | --- |
| `web/` | `npm run dev` | Dev server on :5173, proxies `/api` to the BFF on :3001 |
| `web/` | `npm test`, `npm run lint`, `npm run build` | Tests, lint and type-check, build |
| `bff/` | `npm run dev` | BFF on :3001, restarts on change |
| `bff/` | `npm test`, `npm run lint`, `npm run build` | Tests, type-check and lint (ESLint), build |
| `payments-api/` | `dotnet test` | Unit and API tests |
| `payments-api/` | `GET http://localhost:5080/dev/gateway/charges` | The simulated gateway's ledger: every charge it's captured |
| `surcharge-service/` | `sbt test` | Tests |
| `surcharge-service/` | `GET http://localhost:9000/v1/bins/41111111` | Look up a BIN |
| repo root | `node scripts/load-test.mjs` | Load test the surcharge service (options are at the top of the script) |

## Configuration

Everything has a working default, so `docker compose up`, `npm run dev` and
`sbt run` need nothing set. These variables are read from the process
environment. `docker-compose.yml` doesn't pass them through, so to change
one under Docker, add it to that service's `environment:` there.

| Service | Variable | Default | |
| --- | --- | --- | --- |
| `bff/` | `SURCHARGE_QUOTE_TIMEOUT_MS` | `1500` | How long a preview quote may take before the terminal falls back to "no surcharge" |
| `bff/` | `PAYMENTS_API_TIMEOUT_MS` | `3000` | Timeout for reads from the payments API |
| `bff/` | `PAYMENTS_API_WRITE_TIMEOUT_MS` | `30000` | Timeout for creating a payment or refund. Longer, because the payments API doesn't cancel a charge. |
| `bff/` | `PAYMENT_LIST_CACHE_TTL_MS` | `10000` | Payments list cache lifetime |
| `bff/` | `PAYMENT_LIST_CACHE_MAX_ENTRIES` | `1000` | Payments list cache size cap |
| `surcharge-service/` | `MERCHANT_CACHE_TTL` | `30s` | How long merchant config is cached. Include a unit: a bare `30` is read as milliseconds. `0` turns the cache off. An opt-out or rate change takes up to this long to reach new quotes. |
| `surcharge-service/` | `QUOTE_SIGNING_KEY`, `QUOTE_SIGNING_KEY_ID` | a development key, `dev-1` | Key for signing quotes (at least 32 bytes). The service logs a warning while the development default is in use. |

## Layout

```
docs/surcharging.md        surcharging rules
review/                    a PR to review (see INSTRUCTIONS.md)
scripts/                   load test, BIN table generator
web/                       React terminal
bff/                       Express BFF, Jest tests
  src/
    controllers/           route handlers
    middleware/            API key check, logging, error handler
    routes/                routers, mounted under /api
    services/              payments API and surcharge service clients, caching
payments-api/              ASP.NET Core API, EF Core + SQLite
  src/InterPayments.Payments.Web.Api/
    Controllers/
    Data/                  entities, DbContext, seed data
    Gateway/               gateway interface and the in-process simulator
    Infrastructure/        API key and request logging middleware
    Services/              payment logic, surcharge service client
  src/InterPayments.Payments.Web.Api.UnitTests/   NUnit tests
surcharge-service/         Play service, ScalaTest
  app/services/            BIN table, surcharge rules, quotes
  conf/                    routes, config, BIN table, merchant fixtures
```
