import { NextRequest } from "next/server";
import { LLMClient, type ChatMessage } from "@/lib/llm-sdk";
import { QueueLogSink } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const requestSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1),
  model: z.string().optional(),
  provider: z.enum(["openai", "groq", "anthropic"]).optional(),
});

const encoder = new TextEncoder();
const logSink = new QueueLogSink();

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.issues }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const { message, model, provider } = parsed.data;
  let conversationId = parsed.data.conversationId;

  // Create conversation on first message, with a title derived from the prompt.
  if (!conversationId) {
    const convo = await prisma.conversation.create({
      data: { title: message.slice(0, 80) },
    });
    conversationId = convo.id;
  } else {
    // Reject if cancelled — resume only works for active convos.
    const existing = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!existing) {
      return new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 });
    }
    if (existing.status === "cancelled") {
      return new Response(JSON.stringify({ error: "conversation cancelled" }), { status: 409 });
    }
  }

  // Persist user message.
  await prisma.message.create({
    data: { conversationId, role: "user", content: message },
  });

  // Last 20 messages so we don't blow the token budget. Take newest, then reverse for chronology.
  const azure =
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT
      ? {
          apiKey: process.env.AZURE_OPENAI_API_KEY,
          endpoint: process.env.AZURE_OPENAI_ENDPOINT,
          apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
          deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
        }
      : undefined;

  const sdk = new LLMClient(logSink, {
    azure,
    openaiApiKey: process.env.OPENAI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
  });

  const configured = sdk.configuredProviders();
  const resolvedProvider = provider ?? (configured.includes("openai") ? "openai" : configured[0]);
  if (!resolvedProvider) {
    return new Response(JSON.stringify({ error: "no LLM provider configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // Resolve the display model name so the system prompt is self-aware.
  const resolvedModel =
    model ??
    (resolvedProvider === "openai"
      ? (azure?.deployment ?? "gpt-4o-mini")
      : resolvedProvider === "groq"
        ? "llama-3.3-70b-versatile"
        : "claude-3-5-sonnet");

  const recent = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const history = recent.reverse();
  const systemPrompt = [
    `You are a helpful assistant running on ${resolvedProvider} (model: ${resolvedModel}).`,
    `Format responses in clean GitHub-flavored Markdown: use headings sparingly, prefer short paragraphs and bullet lists, and use fenced code blocks with language tags for code.`,
    `Keep answers concise unless the user asks for depth.`,
  ].join(" ");
  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content })),
  ];

  const controller = new AbortController();
  // If the browser disconnects, abort the upstream call.
  req.signal.addEventListener("abort", () => controller.abort());

  const convoIdLocal = conversationId;

  const stream = new ReadableStream({
    async start(streamCtl) {
      // Emit a small JSON header line so the client learns the conversation id immediately.
      streamCtl.enqueue(
        encoder.encode(JSON.stringify({ type: "meta", conversationId: convoIdLocal }) + "\n")
      );

      let assembled = "";
      try {
        for await (const delta of sdk.chatStream(
          { conversationId: convoIdLocal, messages: chatMessages, model, provider: resolvedProvider },
          controller.signal
        )) {
          assembled += delta;
          streamCtl.enqueue(encoder.encode(delta));
        }
      } catch (err) {
        console.error("[chat] stream error", err);
      } finally {
        // Persist assistant message if we got anything (covers cancelled mid-stream too).
        if (assembled.length > 0) {
          await Promise.all([
            prisma.message.create({
              data: { conversationId: convoIdLocal, role: "assistant", content: assembled },
            }),
            prisma.conversation.update({
              where: { id: convoIdLocal },
              data: { updatedAt: new Date() },
            }),
          ]);
        }
        streamCtl.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-conversation-id": conversationId,
    },
  });
}
