// Lightweight LLM SDK wrapper.
// Responsibilities:
//   1. Provide a single typed interface across providers (OpenAI today, Anthropic next).
//   2. Measure latency, time-to-first-byte, token usage.
//   3. Stream the response back to the caller AND emit an inference log to the ingest endpoint.
//   4. Never let logging failures break the actual chat call (fire-and-forget, with try/catch).
//
// Design choice: the wrapper takes a `logger` injected at construction time so the same wrapper
// can be used from a Next.js route (HTTP fetch to /api/ingest) or directly from a test (in-process).

import OpenAI, { AzureOpenAI } from "openai";
import { randomUUID } from "node:crypto";
import { preview } from "./redact";
import type { InferenceLogInput } from "./schemas";

export type Provider = "openai" | "anthropic";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  conversationId?: string;
  messages: ChatMessage[];
  model?: string;
  provider?: Provider;
  stream?: boolean;
}

export type InferenceLogPayload = InferenceLogInput;

export interface LogSink {
  emit(payload: InferenceLogPayload): Promise<void> | void;
}

// HTTP sink — posts to /api/ingest. Kept for cross-process / external SDK use.
// In-process callers should prefer QueueLogSink to avoid a self-fetch.
export class HttpLogSink implements LogSink {
  constructor(private url: string) {}
  async emit(payload: InferenceLogPayload) {
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (err) {
      console.error("[LogSink] emit failed", err);
    }
  }
}

// Provider abstraction. Adding Anthropic = new class implementing this interface.
interface ProviderAdapter {
  name: Provider;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<{
    delta: string;
    usage?: { prompt: number; completion: number; total: number };
    finish?: string;
  }>;
}

type OpenAIInit =
  | { mode: "openai"; apiKey: string }
  | { mode: "azure"; apiKey: string; endpoint: string; apiVersion: string; deployment: string };

class OpenAIAdapter implements ProviderAdapter {
  name: Provider = "openai";
  private client: OpenAI;
  // When using Azure, `deployment` replaces `model` in every request.
  private azureDeployment?: string;

  constructor(init: OpenAIInit) {
    if (init.mode === "azure") {
      this.client = new AzureOpenAI({
        apiKey: init.apiKey,
        endpoint: init.endpoint,
        apiVersion: init.apiVersion,
        deployment: init.deployment,
      });
      this.azureDeployment = init.deployment;
    } else {
      this.client = new OpenAI({ apiKey: init.apiKey });
    }
  }

  async *stream(req: ChatRequest, signal: AbortSignal) {
    const model = this.azureDeployment ?? req.model ?? "gpt-4o-mini";
    const stream = await this.client.chat.completions.create(
      {
        model,
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      const finish = chunk.choices[0]?.finish_reason ?? undefined;
      const usage = chunk.usage
        ? {
            prompt: chunk.usage.prompt_tokens,
            completion: chunk.usage.completion_tokens,
            total: chunk.usage.total_tokens,
          }
        : undefined;
      if (delta || finish || usage) yield { delta, finish: finish ?? undefined, usage };
    }
  }
}

// Main wrapper.
export class LLMClient {
  private adapters: Record<Provider, ProviderAdapter | null> = {
    openai: null,
    anthropic: null,
  };

  constructor(
    private sink: LogSink,
    opts: {
      openaiApiKey?: string;
      azure?: { apiKey: string; endpoint: string; apiVersion: string; deployment: string };
    } = {}
  ) {
    if (opts.azure) {
      this.adapters.openai = new OpenAIAdapter({ mode: "azure", ...opts.azure });
    } else if (opts.openaiApiKey) {
      this.adapters.openai = new OpenAIAdapter({ mode: "openai", apiKey: opts.openaiApiKey });
    }
  }

  // Streaming chat. Yields text chunks; emits a log when done (or on error / cancel).
  async *chatStream(req: ChatRequest, signal: AbortSignal) {
    const provider: Provider = req.provider ?? "openai";
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error(`Provider ${provider} not configured`);

    const requestId = randomUUID();
    const model = req.model ?? (provider === "openai" ? "gpt-4o-mini" : "claude-3-5-sonnet");
    const startedAt = new Date();
    const startMs = performance.now();
    let firstByteMs: number | undefined;
    let usage: { prompt: number; completion: number; total: number } | undefined;
    let finish: string | undefined;
    let assembled = "";
    let status: "success" | "error" | "cancelled" = "success";
    let errorMessage: string | undefined;

    try {
      for await (const chunk of adapter.stream(req, signal)) {
        if (firstByteMs === undefined && chunk.delta) firstByteMs = performance.now() - startMs;
        if (chunk.delta) {
          assembled += chunk.delta;
          yield chunk.delta;
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.finish) finish = chunk.finish;
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        status = "cancelled";
      } else {
        status = "error";
        errorMessage = err?.message ?? String(err);
      }
    } finally {
      const completedAt = new Date();
      const latencyMs = Math.round(performance.now() - startMs);
      const inputText = req.messages.map((m) => `${m.role}: ${m.content}`).join("\n");

      // Fire-and-forget. Don't await — the route should return first.
      void this.sink.emit({
        requestId,
        conversationId: req.conversationId,
        provider,
        model,
        status,
        errorMessage,
        latencyMs,
        timeToFirstByteMs: firstByteMs ? Math.round(firstByteMs) : undefined,
        promptTokens: usage?.prompt,
        completionTokens: usage?.completion,
        totalTokens: usage?.total,
        inputPreview: preview(inputText) ?? undefined,
        outputPreview: preview(assembled) ?? undefined,
        metadata: { finishReason: finish },
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      });
    }
  }
}
