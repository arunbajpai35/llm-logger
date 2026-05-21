// Real load test against /api/ingest. No mocks — the request goes through the
// same Zod validation, BullMQ enqueue, Redis hop, worker drain, and Postgres
// upsert that production traffic does.
//
// Run:
//   node scripts/loadtest.mjs --url https://marry-ooze-ferris.ngrok-free.dev \
//     --duration 30 --connections 50
//
// Output: prints autocannon's summary (RPS, latency p50/p95/p99) and a few
// follow-up stats from /api/metrics so you can see how many of the synthetic
// requests actually landed in Postgres.

import autocannon from "autocannon";
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const URL = args.url ?? "http://localhost:3000";
const DURATION = Number(args.duration ?? 20);
const CONNECTIONS = Number(args.connections ?? 30);

const NGROK_HEADER = URL.includes("ngrok-free") ? { "ngrok-skip-browser-warning": "1" } : {};

function syntheticPayload() {
  const promptTokens = 80 + Math.floor(Math.random() * 800);
  const completionTokens = 40 + Math.floor(Math.random() * 600);
  const startedAt = new Date();
  const latencyMs = 200 + Math.floor(Math.random() * 4000);
  const status = Math.random() < 0.97 ? "success" : Math.random() < 0.5 ? "error" : "cancelled";
  return JSON.stringify({
    requestId: randomUUID(),
    provider: Math.random() < 0.6 ? "openai" : "groq",
    model: Math.random() < 0.6 ? "gpt-4o-mini" : "llama-3.3-70b-versatile",
    status,
    errorMessage: status === "error" ? "synthetic_error" : undefined,
    latencyMs,
    timeToFirstByteMs: Math.floor(latencyMs * 0.4),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    inputPreview: "synthetic load test prompt — see scripts/loadtest.mjs",
    outputPreview: "synthetic load test response",
    metadata: { source: "loadtest", finishReason: "stop" },
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + latencyMs).toISOString(),
  });
}

console.log(
  `[loadtest] target=${URL}/api/ingest  duration=${DURATION}s  connections=${CONNECTIONS}`
);

const result = await autocannon({
  url: `${URL}/api/ingest`,
  method: "POST",
  duration: DURATION,
  connections: CONNECTIONS,
  headers: { "content-type": "application/json", ...NGROK_HEADER },
  setupClient: (client) => {
    client.setBody(syntheticPayload());
    // Refresh body per request so each ingest has a fresh UUID (otherwise the
    // requestId-keyed dedup turns every request into a no-op upsert).
    client.on("response", () => client.setBody(syntheticPayload()));
  },
});

console.log("\n=== autocannon summary ===");
console.log(
  `requests:  ${result.requests.total}  (${result.requests.average.toFixed(0)} req/s avg)`
);
console.log(`throughput: ${(result.throughput.average / 1024).toFixed(1)} KB/s`);
console.log(`latency:   p50=${result.latency.p50}ms  p95=${result.latency.p97_5}ms  p99=${result.latency.p99}ms  max=${result.latency.max}ms`);
console.log(`non-2xx:   ${result.non2xx}`);
console.log(`errors:    ${result.errors}  timeouts: ${result.timeouts}`);

// Cross-check: pull /api/metrics and report how many of those synthetic logs
// have actually landed in Postgres yet. The worker drains async so a small
// lag is expected.
await new Promise((r) => setTimeout(r, 3000));
try {
  const m = await fetch(`${URL}/api/metrics`, { headers: NGROK_HEADER }).then((r) => r.json());
  console.log("\n=== /api/metrics after test ===");
  console.log(`24h requests in DB: ${m.summary.requests}`);
  console.log(`avg latency: ${Math.round(m.summary.avgLatencyMs ?? 0)}ms`);
  console.log(`avg TTFB:    ${Math.round(m.summary.avgTtfbMs ?? 0)}ms`);
  console.log(`total tokens: ${m.summary.totalTokens.toLocaleString()}`);
  console.log(`cost USD:     $${(m.summary.costUsd ?? 0).toFixed(4)}`);
} catch (err) {
  console.log("metrics fetch failed:", err.message);
}
