// Demo of the auto-instrumented path. The code below is intentionally written
// the way a caller WITHOUT our SDK would write it: `new OpenAI()`, then
// `client.chat.completions.create(...)`. The monkey patch installed at app
// boot turns each such call into an InferenceLog row in Postgres.
//
// The only line the caller adds for conversation-scoped logging is
// `withConversation(id, () => ...)`. Otherwise this would be an out-of-the-box
// OpenAI snippet copy-pasted from their docs.

import { NextRequest, NextResponse } from "next/server";
import OpenAI, { AzureOpenAI } from "openai";
import { prisma } from "@/lib/prisma";
import { withConversation } from "@/lib/instrument";
import { rateLimit, ipFromHeaders } from "@/lib/rate-limit";
import { checkConversationBudget } from "@/lib/budget";
import { z } from "zod";

// Auto-instrumentation is installed by `src/instrumentation.ts` at server boot,
// so by the time this route runs, `OpenAI.Chat.Completions.prototype.create`
// is already patched. Nothing to do here — just write normal SDK code.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const requestSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1),
  model: z.string().optional(),
});

const CHAT_RATE_LIMIT = Number(process.env.CHAT_RATE_LIMIT_PER_MIN ?? "30");

function buildClient() {
  if (
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  ) {
    return {
      client: new AzureOpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      }),
      // For Azure the "model" arg is actually the deployment name.
      defaultModel: process.env.AZURE_OPENAI_DEPLOYMENT,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      defaultModel: "gpt-4o-mini",
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
      }),
      defaultModel: "llama-3.3-70b-versatile",
    };
  }
  return null;
}

export async function POST(req: NextRequest) {
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`auto-chat:${ip}`, CHAT_RATE_LIMIT, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", resetMs: rl.resetMs },
      { status: 429, headers: { "retry-after": Math.ceil(rl.resetMs / 1000).toString() } }
    );
  }

  const body = await req.json();
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const { message, model } = parsed.data;
  let conversationId = parsed.data.conversationId;

  if (!conversationId) {
    const convo = await prisma.conversation.create({ data: { title: message.slice(0, 80) } });
    conversationId = convo.id;
  } else {
    const budget = await checkConversationBudget(conversationId);
    if (!budget.allowed) {
      return NextResponse.json(
        { error: "conversation_token_cap_exceeded", usedTokens: budget.used, cap: budget.cap },
        { status: 429 }
      );
    }
  }
  await prisma.message.create({ data: { conversationId, role: "user", content: message } });

  const built = buildClient();
  if (!built) {
    return NextResponse.json({ error: "no provider configured" }, { status: 500 });
  }
  const { client, defaultModel } = built;

  // Pull recent history (same windowing as /api/chat).
  const recent = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const history = recent.reverse();
  const messages = [
    { role: "system" as const, content: "You are a helpful assistant." },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  // *** This is the entire instrumented call surface. ***
  // No facade, no SDK of ours — just the raw OpenAI SDK. The monkey patch
  // captures latency, TTFB, tokens, finish reason, errors, and writes to
  // InferenceLog through the same ingest pipeline.
  //
  // We thread an AbortController so a browser disconnect aborts the upstream
  // call (and the monkey patch records `status: "cancelled"` instead of
  // burning tokens to completion).
  const convoIdLocal = conversationId;
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(streamCtl) {
      streamCtl.enqueue(
        encoder.encode(JSON.stringify({ type: "meta", conversationId: convoIdLocal }) + "\n")
      );

      let assembled = "";
      try {
        await withConversation(convoIdLocal, async () => {
          const upstream = await client.chat.completions.create(
            {
              model: model ?? defaultModel ?? "gpt-4o-mini",
              messages,
              stream: true,
            },
            { signal: controller.signal }
          );
          for await (const chunk of upstream as any) {
            const delta = chunk?.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              assembled += delta;
              streamCtl.enqueue(encoder.encode(delta));
            }
          }
        });
      } catch (err: any) {
        if (err?.name !== "AbortError") console.error("[auto-chat] stream error", err);
      } finally {
        if (assembled.length > 0) {
          await prisma.message.create({
            data: { conversationId: convoIdLocal, role: "assistant", content: assembled },
          });
          await prisma.conversation.update({
            where: { id: convoIdLocal },
            data: { updatedAt: new Date() },
          });
        }
        streamCtl.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-conversation-id": conversationId,
      "x-instrumented": "auto",
    },
  });
}
