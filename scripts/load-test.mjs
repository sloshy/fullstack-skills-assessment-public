// Load test for the surcharge service's quote endpoint. No dependencies.
//
//   node scripts/load-test.mjs [--url http://localhost:9000] [--concurrency 64] [--duration 20]
//
// Fires random quotes (mixed merchants, amounts and BINs) from N workers for the
// given number of seconds and prints throughput and latency percentiles.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]])
    return pairs
  }, []),
)

const baseUrl = args.url ?? "http://localhost:9000"
const concurrency = Number(args.concurrency ?? 64)
const durationSeconds = Number(args.duration ?? 20)

const merchants = ["mer_001", "mer_002", "mer_003", "mer_004"]
const knownBins = ["41111111", "40000566", "55555555", "52008282", "48471800", "37828224", "60111111"]

const randomBin = () =>
  Math.random() < 0.3
    ? knownBins[Math.floor(Math.random() * knownBins.length)]
    : String(40000000 + Math.floor(Math.random() * 20000000))

// mer_003 is JPY, which has no minor unit: send whole yen, or the service rejects the amount (422)
const randomAmount = (merchantId) => {
  const amount = 5 + Math.random() * 500
  return merchantId === "mer_003" ? Math.round(amount) : Math.round(amount * 100) / 100
}

const body = () => {
  const merchantId = merchants[Math.floor(Math.random() * merchants.length)]
  return JSON.stringify({ merchantId, amount: randomAmount(merchantId), bin: randomBin() })
}

const latencies = []
let errors = 0
const deadline = Date.now() + durationSeconds * 1000

async function worker() {
  while (Date.now() < deadline) {
    const started = performance.now()
    try {
      const response = await fetch(`${baseUrl}/v1/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(),
      })
      await response.arrayBuffer()
      if (!response.ok) errors++
    } catch {
      errors++
    }
    latencies.push(performance.now() - started)
  }
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

console.log(`POST ${baseUrl}/v1/quotes — ${concurrency} workers for ${durationSeconds}s`)
const started = Date.now()
await Promise.all(Array.from({ length: concurrency }, worker))
const elapsed = (Date.now() - started) / 1000

const sorted = latencies.sort((a, b) => a - b)
const fmt = (ms) => `${ms.toFixed(1)} ms`
console.log(`requests: ${sorted.length} (${(sorted.length / elapsed).toFixed(0)}/s), errors: ${errors}`)
console.log(
  `latency  p50 ${fmt(percentile(sorted, 50))}  p95 ${fmt(percentile(sorted, 95))}  p99 ${fmt(percentile(sorted, 99))}  max ${fmt(sorted[sorted.length - 1])}`,
)
