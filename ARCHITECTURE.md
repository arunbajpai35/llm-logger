# Architecture Notes

## Ingestion flow

A single chat turn produces one inference log. The path:

1. **Client → `/api/chat`.** Browser POSTs `{ conversationId?, message }`. Route handler creates the conversation if needed, persists the user message, and pulls the last 20 messages as context.
2. **Chat route → SDK wrapper (`LLMClient`).** Wrapper opens a streaming completion against OpenAI and yields tokens back into the route's `ReadableStream`.
3. **SDK measures.** Start timestamp, time-to-first-byte (set on the first non-empty delta), total latency on stream close, prompt/completion/total tokens from the final usage chunk, finish reason from metadata.
4. **Stream ends → SDK fires log.** A single POST to `/api/ingest` with the full payload. `fetch(..., { keepalive: true })` — the request survives even if the chat route has already returned.
5. **`/api/ingest` validates + enqueues.** Zod schema gates the payload. Valid payloads get pushed to BullMQ with `jobId = requestId` (dedup) and exponential-backoff retries.
6. **Worker drains.** A separate Node process subscribes to the queue and upserts into Postgres. Upsert keyed by `requestId` makes retries idempotent — the same job can fire twice and we still end up with one row.
7. **Dashboard reads aggregates.** Polls `/api/metrics` every 10s; that endpoint runs `PERCENTILE_CONT` and `COUNT(*) FILTER` against `InferenceLog` to produce hourly buckets and 24h rollups.

Why a queue instead of writing straight from `/api/ingest`? Three reasons:
- The chat route shouldn't block on DB writes. Decoupling lets ingest absorb spikes.
- Retries + dead-letter handling come for free with BullMQ.
- Multiple consumers can hang off the same stream later (analytics, fine-tune dataset, alerting) without changing the producer.

## Logging strategy

- **Out-of-band, never in-band.** The SDK fires the log after the chat stream has closed (or errored, or been cancelled). A logging failure cannot break the chat call.
- **One log per inference, not per chunk.** Streaming produces many deltas; we accumulate locally and emit one row at the end. The row captures the full lifecycle: TTFB, total latency, tokens, finish reason, error.
- **Three statuses: `success`, `error`, `cancelled`.** Cancelled is distinct from error because client aborts are a normal product behavior — we still want the partial latency/token data, just not a red bar on the error chart.
- **Previews, not full bodies.** `inputPreview` and `outputPreview` are PII-redacted, truncated to 500 chars. Full message bodies live only in `Message`. Keeps the log table small and reduces PII surface.
- **`requestId` is the unit of dedup.** Generated in the SDK before the call starts, used as the BullMQ job ID and the Postgres unique key.

## Scaling considerations

Where this breaks first as load grows, and what to do:

| Bottleneck | When it hurts | Mitigation |
|---|---|---|
| Single Next.js process for chat + ingest | A few thousand RPS, or one slow ingest backing up event loop | Split into two services; autoscale ingest independently |
| Postgres write throughput on `InferenceLog` | Tens of thousands of logs/min | Batch upserts in the worker (e.g. 100 logs / 200ms windows); eventually move logs to Clickhouse |
| Dashboard aggregation cost | When `InferenceLog` crosses ~10M rows | Pre-aggregate hourly rollups via a materialized view or a scheduled job |
| Single worker | Sustained queue depth growth | BullMQ supports multiple workers out of the box; deploy more replicas |
| Connection limits | More than ~100 concurrent DB clients | PgBouncer in front of Postgres |
| Redis as queue + ratelimit + cache | Mixed workload causing latency spikes | Separate Redis instances per role |

The components are stateless except for Postgres and Redis, so horizontal scaling is just "add replicas."

## Failure handling assumptions

- **Logging is best-effort, chat is not.** If `/api/ingest` is down, the chat user is unaffected — they see their tokens stream normally; the log is dropped after the fetch's keepalive window. In a production system I'd add a small in-memory ring buffer in the SDK with retry-on-next-call, but for a take-home, fire-and-forget is honest about its tradeoff.
- **Validation failures are not retried.** If the worker pulls a malformed payload, it fails permanently into the dead-letter (BullMQ `removeOnFail: 5000`). Transient failures (DB connection blip) get 3 attempts with exponential backoff.
- **Cancellation is cooperative.** When the browser aborts, the chat route catches it on `req.signal` and aborts the upstream OpenAI call. The SDK's `finally` block still fires the log with `status: 'cancelled'` and whatever partial data it had.
- **Worker crash mid-job.** BullMQ marks the job as stalled after a timeout and another worker picks it up. Upsert keyed on `requestId` makes this safe.
- **Postgres unreachable on the chat path.** The chat route fails fast — we don't try to be clever, because the user message and assistant response are persisted there and silently dropping them would be worse than a clear error.
- **Redis unreachable.** Ingest endpoint returns 503, SDK swallows it (logging is best-effort). Chat path is unaffected.
- **OpenAI errors or times out.** The SDK catches, marks the log `status: 'error'` with the message, and the chat route surfaces an error to the UI. No assistant message is persisted (so the conversation history stays clean for the retry).

## Security notes

- API key is server-side only (`OPENAI_API_KEY` in env, never sent to the browser).
- PII redaction runs before any text touches `InferenceLog`. Coverage is regex-based and listed in `redact.ts` — emails, phones, cards, SSN, PAN, Aadhaar, API-key-looking tokens. Documented as a limited first pass, not as production-grade redaction.
- No auth in the demo (out of scope for a take-home). In production every route gates on a session, and the SDK takes an API key.
- The ingestion endpoint is open in this demo. In production it'd require an SDK key tied to an org.
