# LLM Logger

A lightweight inference logging and ingestion system for an LLM application: a streaming chatbot, an SDK that captures inference metadata around every model call, an event-driven ingestion pipeline, and a dashboard for latency / throughput / errors.

## Demo

**Live:** https://puerto-environmental-prefers-sur.trycloudflare.com — exposed via Cloudflare Quick Tunnel to the local kind cluster, so the link is only up while the tunnel is running. If it's down by the time you read this, the screenshots below show the same app.

| Chat (empty) | Chat (multi-turn, markdown) |
|---|---|
| ![Chat empty](docs/screenshots/01-chat-empty.png) | ![Chat conversation](docs/screenshots/02-chat-conversation.png) |

| Conversations (list / resume / cancel) | Dashboard (latency, throughput, tokens, cost) |
|---|---|
| ![Conversations](docs/screenshots/03-conversations.png) | ![Dashboard](docs/screenshots/04-dashboard.png) |

## Quickstart

```bash
# 1. Set your API key
cp .env.example .env
# edit .env and set OPENAI_API_KEY (or AZURE_OPENAI_* for Azure).
# Optional: also set GROQ_API_KEY to get a second provider in the UI dropdown — free at https://console.groq.com

# 2. Bring everything up
docker compose up --build

# 3. Open the app
open http://localhost:3000
```

That's it. One command brings up Postgres, Redis, the Next.js app, and the ingestion worker. Migrations run on app start.

### Local dev (without Docker)

```bash
docker compose up -d postgres redis     # just the infra
npm install
npx prisma migrate dev
npm run dev                              # Next.js on :3000
npm run worker                           # in another terminal
```

## Architecture overview

```
   ┌────────────┐     stream      ┌──────────────┐    fire-and-forget    ┌──────────────┐
   │  Chat UI   │ ───────────────▶│ /api/chat    │ ─────────────────────▶│ /api/ingest  │
   │ (Next.js)  │◀── tokens ──────│ (Next.js)    │                       │  (Next.js)   │
   └────────────┘                 │  + SDK       │                       └──────┬───────┘
                                  │   wrapper    │                              │ enqueue
                                  └──────┬───────┘                              ▼
                                         │ writes msgs               ┌───────────────────┐
                                         ▼                           │ BullMQ (Redis)    │
                                  ┌────────────┐                     └─────────┬─────────┘
                                  │ Postgres   │◀────── upsert log ────────────┘ worker
                                  └────────────┘
                                         ▲
                                         │ aggregates
                                  ┌────────────┐
                                  │ Dashboard  │
                                  └────────────┘
```

**Flow on one chat turn:**
1. Browser POSTs to `/api/chat`. The route creates/finds the conversation, builds a context window (last 20 messages), and calls the SDK wrapper.
2. The SDK wrapper streams tokens from the configured provider (OpenAI, Azure OpenAI, or Groq) back to the browser **and** measures latency, TTFB, token usage, finish reason.
3. When the stream ends (success, error, or client cancel), the SDK fires a single POST to `/api/ingest` with the inference log. This is fire-and-forget — logging must never block or break the chat.
4. `/api/ingest` validates with Zod and enqueues a job to BullMQ (keyed by `requestId` for dedup).
5. The worker drains the queue and upserts into Postgres. Upsert + dedup key = retries are idempotent.
6. The dashboard queries Postgres aggregates (PERCENTILE_CONT for p50/p95) every 10 seconds.

## Components

| Piece | Where | What it does |
|---|---|---|
| Chat UI | `src/app/page.tsx` | Streaming chat, supports resume via `?id=`, cancel |
| Conversations UI | `src/app/conversations/page.tsx` | List, resume, cancel, delete |
| Dashboard | `src/app/dashboard/page.tsx` | Recharts panels for latency, throughput, errors, tokens |
| SDK wrapper | `src/lib/llm-sdk.ts` | Multi-provider, streaming, captures metadata, emits to a `LogSink` |
| Ingest API | `src/app/api/ingest/route.ts` | Zod-validates, enqueues to BullMQ |
| Worker | `src/workers/ingest-worker.ts` | Drains queue, upserts into Postgres |
| Metrics API | `src/app/api/metrics/route.ts` | 24h aggregates with raw SQL percentiles |
| PII redaction | `src/lib/redact.ts` | Regex pass for emails, phones, cards, SSN, PAN, Aadhaar, secrets |

## Schema design decisions

See `prisma/schema.prisma`. Headlines:

- **`Conversation`, `Message`, `InferenceLog` are three separate tables.** A failed inference produces a log but no assistant message. Splitting them lets us run heavy metadata queries (latency p95, error rates) without scanning message text.
- **`InferenceLog.requestId` is unique.** Client-generated UUID, used both as the BullMQ job ID (dedup) and the upsert key in Postgres (idempotency).
- **JSONB `metadata` column** for provider-specific fields (finish reason, raw response bits). Avoids schema churn when providers change response shapes.
- **Indexes match the actual query patterns:** `(status, updatedAt)` for the conversation list, `(createdAt)` and `(provider, model, createdAt)` for the dashboard, `(conversationId, createdAt)` for message ordering.
- **`onDelete: SetNull` from `InferenceLog` → `Conversation`** so deleting a chat doesn't lose the inference metadata (cost analytics survive).
- **`inputPreview` / `outputPreview`** are truncated, PII-redacted copies. Full text lives only in `Message`. Logs stay queryable without putting raw PII in metadata tables.

## Tradeoffs

- **BullMQ over Kafka.** Kafka would be the real production choice for an ingestion bus. BullMQ + Redis is the smallest credible event-driven setup — it gets you retries, dedup, dead-letter, and concurrency without standing up Zookeeper/Kraft. Easy to swap later: the worker is just a function.
- **Postgres over Clickhouse/Timescale.** A real metrics workload would use Clickhouse for log volume and aggregation speed. For this scale, Postgres + the right indexes + `PERCENTILE_CONT` is fine and avoids a second datastore.
- **Regex PII redaction.** Will miss anything not on the pattern list. Production would use Microsoft Presidio or a similar entity recognizer. Documented limitation, not a gap I'd ship to prod.
- **Same Next.js app serves UI + chat + ingest.** In production these would be separate services so a noisy ingest endpoint can't degrade chat latency. Mentioned in "what I'd improve."
- **20-message context window.** Hardcoded; should be model-aware (token budget) eventually.
- **No auth.** Out of scope for the take-home; would gate every route behind a session in production.
- **Worker runs in a single process.** Horizontal scaling needs a separate deployment; the code is ready (concurrency: 8, stateless), the topology isn't.

## What I'd improve with more time

1. **Split services.** Chat app, ingest API, and worker as separate deployments. Move ingest behind a load balancer with its own autoscaling profile.
2. **Real event bus.** Kafka or Redpanda with a schema registry. Lets multiple consumers (analytics warehouse, alerting, fine-tune dataset builder) tap the same stream.
3. **Move logs to Clickhouse.** Keep `Conversation` and `Message` in Postgres; ship `InferenceLog` to Clickhouse for cheap aggregations at scale.
4. **PII redaction with Presidio** (or a small classifier) instead of regex. Add a per-org allowlist of "this is OK to log."
5. **Auth + multi-tenancy.** `OrgId` on every row, RLS in Postgres, API keys for the SDK so external apps can ship logs.
6. **Cost tracking.** Multiply tokens by a per-model price table; surface $/conversation, $/user, $/model.
7. **Tracing.** OpenTelemetry spans around every LLM call. Send to Tempo/Jaeger; correlate dashboard metrics with trace IDs.
8. **Anthropic + Gemini adapters.** Interface is already there; ~30 lines each.
9. **Tests.** Vitest for the SDK wrapper (the part most worth pinning down) + a Playwright happy-path for the chat UI.
10. **k8s deploy.** Helm chart with separate deployments for `web`, `worker`, `postgres`, `redis`, HPA on the worker.

## Bonus checklist

- [x] Multi-provider support — `ProviderAdapter` interface with OpenAI (incl. Azure) and Groq implemented; UI exposes a per-message provider selector when more than one is configured. Anthropic is a drop-in.
- [x] Streaming responses — end-to-end via `ReadableStream` and OpenAI's stream.
- [x] Latency + throughput + errors dashboards — Recharts, refreshes every 10s.
- [x] Docker Compose one-command setup — `docker compose up --build`.
- [x] Event-based architecture — BullMQ + Redis between ingest API and DB writer.
- [x] PII redaction — regex pass before `inputPreview` / `outputPreview` are persisted.
- [x] Cancel conversation — UI button + `PATCH /api/conversations/:id`.
- [x] List conversations — `/conversations` page.
- [x] Resume a conversation — `/?id=<conversationId>`.
- [x] k8s deploy — raw manifests under `k8s/` (Namespace, ConfigMap, Secret, Postgres StatefulSet, Redis StatefulSet, migrate Job, web Deployment + NodePort Service, worker Deployment). Verified end-to-end on a local `kind` cluster.

## Deploy on Kubernetes (kind)

Raw manifests live in `k8s/`. The flow below brings the whole stack up on a local [kind](https://kind.sigs.k8s.io/) cluster — same containers as `docker compose`, just orchestrated by k8s.

```bash
# 1. Build the images locally
docker compose build app worker

# 2. Create a kind cluster that maps NodePort 30000 -> host 3000
kind create cluster --config k8s/kind-cluster.yaml

# 3. Load local images into the cluster (no registry needed)
kind load docker-image llm-logger-app:latest llm-logger-worker:latest --name llm-logger

# 4. Namespace + ConfigMap
kubectl apply -f k8s/namespace.yaml -f k8s/configmap.yaml

# 5. Secrets — supply your provider keys. Either copy the example and edit:
cp k8s/secret.example.yaml k8s/secret.yaml      # k8s/secret.yaml is gitignored
kubectl apply -f k8s/secret.yaml
# ...or create directly:
kubectl -n llm-logger create secret generic app-secrets \
  --from-literal=OPENAI_API_KEY=sk-... \
  --from-literal=GROQ_API_KEY=gsk_...

# 6. Datastores, schema migration, and the app
kubectl apply -f k8s/postgres.yaml -f k8s/redis.yaml
kubectl apply -f k8s/migrate-job.yaml
kubectl apply -f k8s/web.yaml -f k8s/worker.yaml

# 7. Open the app
open http://localhost:3000
```

Topology — `web` and `worker` are separate Deployments so they scale independently. Postgres and Redis are StatefulSets with PVCs (1 replica each; dev-grade). The `prisma-migrate` Job waits for Postgres via an init container, then runs `prisma migrate deploy` once per install.

## Project layout

```
src/
  app/
    page.tsx                          # Chat UI
    conversations/page.tsx            # List / resume / cancel
    dashboard/page.tsx                # Charts
    api/
      chat/route.ts                   # Streaming chat endpoint
      ingest/route.ts                 # Log ingestion (validates + enqueues)
      conversations/route.ts          # List
      conversations/[id]/route.ts     # Get / PATCH (cancel) / DELETE
      metrics/route.ts                # Dashboard aggregates
  lib/
    llm-sdk.ts                        # The SDK wrapper
    prisma.ts                         # Prisma client singleton
    queue.ts                          # BullMQ producer
    redact.ts                         # PII redaction
    schemas.ts                        # Zod validation
  workers/
    ingest-worker.ts                  # Queue consumer
prisma/
  schema.prisma
docker-compose.yml
Dockerfile
```
