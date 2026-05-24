// Demo of the "custom AI" path. There is no SDK here — this route talks to
// Groq via raw `fetch()` against the OpenAI-compatible endpoint, the way a
// caller talking to an internal LLM, vLLM, or any custom provider would.
// The `logInference` wrapper times the call and emits a structured log
// through the same /api/ingest -> BullMQ -> Postgres pipeline.
//
// This is the answer to "the SDK should support custom AI": users who can't
// monkey-patch a third-party class still get one-line instrumentation.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logInference, withConversation } from "@/lib/instrument";
import { rateLimit, ipFromHeaders } from "@/lib/rate-limit";
import { checkConversationBudget } from "@/lib/budget";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const requestSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1),
  model: z.string().optional(),
});

const CHAT_RATE_LIMIT = Number(process.env.CHAT_RATE_LIMIT_PER_MIN ?? "30");

export async function POST(req: NextRequest) {
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`custom-chat:${ip}`, CHAT_RATE_LIMIT, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", resetMs: rl.resetMs },
      { status: 429, headers: { "retry-after": Math.ceil(rl.resetMs / 1000).toString() } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  const { message, model } = parsed.data;
  let conversationId = parsed.data.conversationId;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY not set — this demo route uses Groq as the 'custom' provider" },
      { status: 500 }
    );
  }

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

  const recent = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const history = recent.reverse();
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const usedModel = model ?? "llama-3.3-70b-versatile";
  const convoIdLocal = conversationId;
  const encoder = new TextEncoder();

  // Propagate browser disconnect into the upstream fetch. Without this the
  // fetch keeps running, we keep getting billed tokens, and logInference
  // records `success` for a response no one received.
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamCtl) {
      streamCtl.enqueue(
        encoder.encode(JSON.stringify({ type: "meta", conversationId: convoIdLocal }) + "\n")
      );

      let assembled = "";
      try {
        await withConversation(convoIdLocal, () =>
          logInference(
            {
              provider: "custom-groq-fetch",
              model: usedModel,
              inputText: messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
              streamHint: true,
            },
            async (record) => {
              // Raw fetch against the OpenAI-compatible /chat/completions endpoint.
              // No SDK, no class to monkey-patch. logInference still captures
              // latency, TTFB (via record.delta), tokens (via record.usage),
              // and emits to the same pipeline.
              const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model: usedModel,
                  messages,
                  stream: true,
                  stream_options: { include_usage: true },
                }),
                signal: controller.signal,
              });
              if (!upstream.ok || !upstream.body) {
                throw new Error(`upstream ${upstream.status}`);
              }

              // Parse the SSE stream by hand.
              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              let buf = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith("data:")) continue;
                  const payload = trimmed.slice(5).trim();
                  if (payload === "[DONE]") continue;
                  try {
                    const chunk = JSON.parse(payload);
                    const text = chunk?.choices?.[0]?.delta?.content;
                    if (text) {
                      record.delta(text);
                      assembled += text;
                      streamCtl.enqueue(encoder.encode(text));
                    }
                    const finish = chunk?.choices?.[0]?.finish_reason;
                    if (finish) record.finish(finish);
                    if (chunk?.usage) {
                      record.usage({
                        prompt: chunk.usage.prompt_tokens,
                        completion: chunk.usage.completion_tokens,
                        total: chunk.usage.total_tokens,
                      });
                    }
                  } catch {
                    // Ignore malformed SSE lines.
                  }
                }
              }
            }
          )
        );
      } catch (err: any) {
        if (err?.name !== "AbortError") console.error("[custom-chat] error", err);
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
      "x-instrumented": "manual",
    },
  });
}
