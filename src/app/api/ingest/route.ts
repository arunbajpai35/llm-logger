import { NextRequest, NextResponse } from "next/server";
import { inferenceLogSchema } from "@/lib/schemas";
import { ingestQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = inferenceLogSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", issues: parsed.error.issues }, { status: 400 });
  }

  // Enqueue. Use requestId as job ID so duplicate posts dedupe at the queue layer.
  await ingestQueue.add("log", parsed.data, {
    jobId: parsed.data.requestId,
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  });

  return NextResponse.json({ accepted: true, requestId: parsed.data.requestId }, { status: 202 });
}
