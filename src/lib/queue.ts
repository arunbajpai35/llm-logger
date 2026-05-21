import { Queue } from "bullmq";
import IORedis, { Redis } from "ioredis";
import type { LogSink, InferenceLogPayload } from "./llm-sdk";

// Memoize the Redis connection across HMR reloads in dev so we don't leak sockets.
const globalForRedis = globalThis as unknown as { __redis?: Redis };

export const queueConnection: Redis =
  globalForRedis.__redis ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    // Don't connect on construction — Next.js build imports this module for route analysis.
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== "production") globalForRedis.__redis = queueConnection;

export const ingestQueue = new Queue("inference-logs", { connection: queueConnection });

// In-process log sink — writes directly to BullMQ instead of self-fetching /api/ingest.
// Same dedup semantics: requestId is the job ID.
export class QueueLogSink implements LogSink {
  async emit(payload: InferenceLogPayload) {
    try {
      await ingestQueue.add("log", payload, {
        jobId: payload.requestId,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      });
    } catch (err) {
      console.error("[QueueLogSink] enqueue failed", err);
    }
  }
}
