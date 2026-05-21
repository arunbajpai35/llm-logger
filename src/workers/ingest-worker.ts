import { Worker, UnrecoverableError } from "bullmq";
import { prisma } from "../lib/prisma";
import { queueConnection } from "../lib/queue";
import { inferenceLogSchema } from "../lib/schemas";
import { computeCostUsd } from "../lib/pricing";

const worker = new Worker(
  "inference-logs",
  async (job) => {
    const parsed = inferenceLogSchema.safeParse(job.data);
    if (!parsed.success) {
      // Bad payload — skip retries, this will never succeed.
      throw new UnrecoverableError("validation_failed: " + JSON.stringify(parsed.error.issues));
    }
    const d = parsed.data;

    const costUsd = computeCostUsd({
      provider: d.provider,
      model: d.model,
      promptTokens: d.promptTokens,
      completionTokens: d.completionTokens,
    });

    const data = {
      conversationId: d.conversationId,
      provider: d.provider,
      model: d.model,
      status: d.status,
      errorMessage: d.errorMessage,
      latencyMs: d.latencyMs,
      timeToFirstByteMs: d.timeToFirstByteMs,
      promptTokens: d.promptTokens,
      completionTokens: d.completionTokens,
      totalTokens: d.totalTokens,
      costUsd: costUsd ?? null,
      inputPreview: d.inputPreview,
      outputPreview: d.outputPreview,
      metadata: d.metadata ?? {},
      startedAt: new Date(d.startedAt),
      completedAt: d.completedAt ? new Date(d.completedAt) : null,
    };

    // requestId-keyed upsert keeps retries and duplicate enqueues idempotent.
    await prisma.inferenceLog.upsert({
      where: { requestId: d.requestId },
      create: { requestId: d.requestId, ...data },
      update: data,
    });
  },
  { connection: queueConnection, concurrency: 8 }
);

worker.on("ready", () => console.log("[worker] ready, draining inference-logs"));
worker.on("failed", (job, err) => console.error("[worker] failed", job?.id, err.message));
worker.on("completed", (job) => console.log("[worker] ok", job.id));

const shutdown = async (signal: string) => {
  console.log(`[worker] ${signal} received, draining`);
  await worker.close();
  await queueConnection.quit();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
