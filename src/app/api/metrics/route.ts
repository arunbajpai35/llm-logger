import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Returns last 24h of logs bucketed by hour with p50/p95 latency, throughput, error rate.
export async function GET() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Raw SQL: percentiles need PERCENTILE_CONT which Prisma doesn't expose directly.
  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        bucket: Date;
        total: bigint;
        errors: bigint;
        p50: number | null;
        p95: number | null;
        tokens: bigint | null;
      }>
    >`
      SELECT
        date_trunc('hour', "createdAt") AS bucket,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status = 'error')::bigint AS errors,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95,
        SUM("totalTokens")::bigint AS tokens
      FROM "InferenceLog"
      WHERE "createdAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    prisma.inferenceLog.aggregate({
      where: { createdAt: { gte: since } },
      _count: true,
      _avg: { latencyMs: true, timeToFirstByteMs: true },
      _sum: {
        totalTokens: true,
        promptTokens: true,
        completionTokens: true,
        costUsd: true,
      },
    }),
  ]);

  const errorCount = rows.reduce((sum, r) => sum + Number(r.errors), 0);

  return NextResponse.json({
    since: since.toISOString(),
    summary: {
      requests: totals._count,
      errors: errorCount,
      errorRate: totals._count ? errorCount / totals._count : 0,
      avgLatencyMs: totals._avg.latencyMs,
      avgTtfbMs: totals._avg.timeToFirstByteMs,
      totalTokens: Number(totals._sum.totalTokens ?? 0),
      promptTokens: Number(totals._sum.promptTokens ?? 0),
      completionTokens: Number(totals._sum.completionTokens ?? 0),
      // Decimal -> string -> number. Sum is in dollars, six-decimal precision.
      costUsd: Number(totals._sum.costUsd?.toString() ?? "0"),
    },
    buckets: rows.map((r) => ({
      bucket: r.bucket,
      total: Number(r.total),
      errors: Number(r.errors),
      p50: r.p50,
      p95: r.p95,
      tokens: Number(r.tokens ?? 0),
    })),
  });
}
