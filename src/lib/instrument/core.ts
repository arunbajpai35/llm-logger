// Shared core for the auto-instrumentation layer.
//
// The framework's job is to wrap a provider SDK's methods so every call goes
// through our timing + logging path without the caller changing their code.
// The per-provider adapter (see `./openai.ts`, `./anthropic.ts`) supplies the
// four things the framework can't know on its own:
//
//   1. which method on which class to patch
//   2. how to read the request shape (model, messages)
//   3. how to walk the response / stream chunks (deltas, usage, finish)
//   4. how to translate that into our InferenceLogPayload
//
// Why monkey-patch and not a facade: the caller writes their normal SDK code
// (`client.chat.completions.create(...)`) and gets instrumented for free.
// This is what OpenLLMetry / OpenInference / Langfuse-JS do — one adapter
// per SDK, shared timing core.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { preview } from "../redact";
import { QueueLogSink } from "../queue";
import { breakerFor, CircuitOpenError } from "../circuit-breaker";
import type { LogSink, InferenceLogPayload } from "../llm-sdk";

// AsyncLocalStorage so the patched method can pick up `conversationId`
// without changing the SDK's call signature. Callers opt in:
//
//   await withConversation(convoId, () =>
//     openai.chat.completions.create({ ... })
//   );
//
// If no context is set, the log is still emitted but with no convo association.
//
// **Pin to globalThis** because Next.js's webpack can split this module across
// multiple bundles (one per route chunk + the instrumentation bundle). Each
// bundle would otherwise get its OWN `new AsyncLocalStorage()` instance — the
// route writes to one ALS, the patched method reads from another, and the
// conversationId silently goes missing. The Symbol.for() key gives us a
// process-wide singleton across all module instances.
export interface CallContext {
  conversationId?: string;
}
const STORE_KEY = Symbol.for("llm-logger.instrument.conversationStore");
type GlobalWithStore = typeof globalThis & {
  [STORE_KEY]?: AsyncLocalStorage<CallContext>;
};
const g = globalThis as GlobalWithStore;
export const conversationStore: AsyncLocalStorage<CallContext> =
  g[STORE_KEY] ?? new AsyncLocalStorage<CallContext>();
g[STORE_KEY] = conversationStore;

export function withConversation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  return conversationStore.run({ conversationId }, fn);
}

export function currentConversationId(): string | undefined {
  return conversationStore.getStore()?.conversationId;
}

// Per-process default sink — same path as the rest of the app:
// /api/ingest -> BullMQ -> worker -> Postgres.
let defaultSink: LogSink | null = null;
function getSink(): LogSink {
  if (!defaultSink) defaultSink = new QueueLogSink();
  return defaultSink;
}
export function setLogSink(sink: LogSink) {
  defaultSink = sink;
}

// Normalized shapes the adapter speaks.
export interface NormalizedRequest {
  provider: string;
  model: string;
  inputText: string; // joined for preview only — the SDK already has the real messages
  stream: boolean;
}

export interface NormalizedUsage {
  prompt: number;
  completion: number;
  total: number;
}

// Returned by the adapter for non-streaming calls.
export interface NormalizedResult {
  outputText: string;
  usage?: NormalizedUsage;
  finish?: string;
}

// Returned by the adapter for streaming calls — one entry per chunk.
export interface NormalizedDelta {
  text?: string;
  usage?: NormalizedUsage;
  finish?: string;
}

export interface ProviderAdapter<TArgs extends any[], TResp> {
  name: string; // "openai" | "anthropic" | ...
  // Run once at install time. Returns true if the SDK is present and was
  // patched; false otherwise (so we don't fail when an optional SDK isn't installed).
  install(): boolean;
  // For tests / introspection.
  isInstalled(): boolean;
}

// Sentinel set on a method we've already wrapped, so double-install is a no-op.
const PATCHED = Symbol.for("llm-logger.patched");

interface Patchable {
  prototype: Record<string, any>;
}

// Generic helper: wrap a method on a class prototype.
//   - extractRequest:    turn the caller's args into our normalized shape
//   - handleNonStreaming: given the awaited response, return final usage/text
//   - handleStreaming:    given the stream iterable, return a wrapping iterable
//                         that yields to the caller AND records deltas
//
// We force-enable stream usage reporting where the SDK supports it so we can
// always emit token counts. If the caller already set the flag we leave it alone.
export function patchMethod<TArgs extends any[], TResp>(opts: {
  target: Patchable;
  method: string;
  provider: string;
  extractRequest: (args: TArgs) => NormalizedRequest;
  patchArgs?: (args: TArgs) => TArgs; // optional: mutate args before forwarding (e.g. enable usage)
  handleNonStreaming: (response: TResp) => NormalizedResult;
  handleStreaming: (stream: AsyncIterable<any>) => {
    // Forwarded to the caller. The framework iterates this and accumulates
    // deltas via `onDelta` below; the iterator returned to the caller is a
    // tee'd copy so they see chunks at the same time.
    parse: (chunk: any) => NormalizedDelta;
  };
}) {
  const { target, method, provider } = opts;
  const original = target.prototype[method];
  if (!original) {
    console.warn(`[instrument] ${provider}: method ${method} not found, skipping`);
    return;
  }
  if ((original as any)[PATCHED]) return; // idempotent

  const wrapped = async function (this: any, ...args: TArgs) {
    const requestId = randomUUID();
    const conversationId = currentConversationId();
    const startedAt = new Date();
    const t0 = performance.now();
    let firstByteMs: number | undefined;
    let assembled = "";
    let usage: NormalizedUsage | undefined;
    let finish: string | undefined;
    let status: "success" | "error" | "cancelled" = "success";
    let errorMessage: string | undefined;

    const finalArgs = opts.patchArgs ? opts.patchArgs(args) : args;
    const req = opts.extractRequest(finalArgs);

    const emit = () => {
      // Fire-and-forget by contract: a logging failure must NEVER propagate
      // back to the LLM caller. `await`ing would block the chat path on
      // ingest; not catching would leak a sync throw out of getSink().emit()
      // (e.g. BullMQ in a bad state, sink misconfigured) up to the user.
      try {
        const completedAt = new Date();
        const latencyMs = Math.round(performance.now() - t0);
        const result = getSink().emit({
          requestId,
          conversationId,
          provider,
          model: req.model,
          status,
          errorMessage,
          latencyMs,
          timeToFirstByteMs: firstByteMs !== undefined ? Math.round(firstByteMs) : undefined,
          promptTokens: usage?.prompt,
          completionTokens: usage?.completion,
          totalTokens: usage?.total,
          inputPreview: preview(req.inputText) ?? undefined,
          outputPreview: preview(assembled) ?? undefined,
          metadata: { finishReason: finish, source: "auto-instrument" },
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
        } satisfies InferenceLogPayload);
        // Catch async rejections too (`emit` may be sync or async per the
        // LogSink contract).
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch((err) =>
            console.error("[instrument] sink emit rejected", err)
          );
        }
      } catch (err) {
        console.error("[instrument] sink emit threw", err);
      }
    };

    // Caller-provided abort signal (OpenAI SDK passes it via `options.signal`,
    // i.e. args[1].signal). We use it as a ground-truth cancel check because
    // different SDKs wrap AbortError into their own error class — checking
    // `err.name === "AbortError"` alone misses e.g. OpenAI's
    // `APIUserAbortError`. If the signal is aborted, we treat the outcome as
    // cancelled regardless of how the underlying SDK surfaced it.
    const callerSignal: AbortSignal | undefined =
      (args[1] as any)?.signal ?? (args[0] as any)?.signal;
    const wasCancelled = (err: any) =>
      err?.name === "AbortError" ||
      err?.name === "APIUserAbortError" ||
      callerSignal?.aborted === true;

    // Circuit breaker — same per-process, per-provider instance the explicit
    // facade uses, so a string of upstream failures opens the breaker for
    // ALL paths (facade, monkey-patched, manual). User cancels do not trip it.
    const breaker = breakerFor(provider);

    try {
      breaker.precheck();
      const result = await original.apply(this, finalArgs);

      if (!req.stream) {
        const norm = opts.handleNonStreaming(result as TResp);
        assembled = norm.outputText;
        usage = norm.usage;
        finish = norm.finish;
        breaker.markSuccess();
        emit();
        return result;
      }

      // Streaming: return a wrapping async iterable. We iterate the original
      // stream and re-yield to the caller, recording deltas on the way through.
      const { parse } = opts.handleStreaming(result as AsyncIterable<any>);
      const source = result as AsyncIterable<any>;

      const wrappedStream = (async function* () {
        try {
          for await (const chunk of source) {
            const delta = parse(chunk);
            if (delta.text) {
              if (firstByteMs === undefined) firstByteMs = performance.now() - t0;
              assembled += delta.text;
            }
            if (delta.usage) usage = delta.usage;
            if (delta.finish) finish = delta.finish;
            yield chunk;
          }
          // Ground-truth cancel check: the SDK may have exited the iterator
          // cleanly (no throw) when the caller aborted. Treat that as cancel.
          if (callerSignal?.aborted) {
            status = "cancelled";
          } else {
            breaker.markSuccess();
          }
        } catch (err: any) {
          if (wasCancelled(err)) {
            status = "cancelled";
            // user cancel — do NOT count against breaker
          } else {
            status = "error";
            errorMessage = err?.message ?? String(err);
            breaker.markFailure();
          }
          throw err;
        } finally {
          emit();
        }
      })();
      return wrappedStream;
    } catch (err: any) {
      if (err instanceof CircuitOpenError) {
        status = "error";
        errorMessage = `circuit_open:${provider}`;
      } else if (wasCancelled(err)) {
        status = "cancelled";
      } else {
        status = "error";
        errorMessage = err?.message ?? String(err);
        breaker.markFailure();
      }
      emit();
      throw err;
    }
  };

  (wrapped as any)[PATCHED] = true;
  target.prototype[method] = wrapped;
}

// Public extension surface ---------------------------------------------------
//
// For SDKs we don't ship an adapter for, callers can register their own. Two
// shapes:
//
//   1. `registerInstrumentation(install)` — install function that monkey-patches
//       some class. Mirrors what `instrumentOpenAI` / `instrumentAnthropic` do
//       internally. Use this when the user's LLM has a JS class-based SDK.
//
//   2. `logInference(req, fn)` — manual wrapper around any async function.
//       Use this when there's no SDK at all (raw HTTP, gRPC, custom protocol),
//       or when the user can't / won't monkey-patch a third-party library.
//
// Both write to the same /api/ingest -> BullMQ -> Postgres pipeline as the
// built-in adapters, so they share the dashboard, cost calc, and cancel/budget
// semantics.

const customInstallers: Array<() => boolean> = [];
export function registerInstrumentation(install: () => boolean) {
  customInstallers.push(install);
}
export function runCustomInstallers(): string[] {
  const installed: string[] = [];
  for (let i = 0; i < customInstallers.length; i++) {
    try {
      if (customInstallers[i]!()) installed.push(`custom#${i}`);
    } catch (err) {
      console.warn("[instrument] custom installer failed", err);
    }
  }
  return installed;
}

// Manual instrumentation. The async `fn` is timed; whatever it resolves to is
// returned unchanged. `req` tells the framework what to log (you can pass
// streamed text via the `onDelta` callback if you want TTFB / per-chunk text
// preview).
export async function logInference<T>(
  req: {
    provider: string;
    model: string;
    inputText?: string;
    streamHint?: boolean; // set true if you'll call `record` repeatedly
  },
  fn: (record: {
    delta: (text: string) => void;
    usage: (u: NormalizedUsage) => void;
    finish: (reason: string) => void;
  }) => Promise<T>
): Promise<T> {
  const requestId = randomUUID();
  const conversationId = currentConversationId();
  const startedAt = new Date();
  const t0 = performance.now();
  let firstByteMs: number | undefined;
  let assembled = "";
  let usage: NormalizedUsage | undefined;
  let finish: string | undefined;
  let status: "success" | "error" | "cancelled" = "success";
  let errorMessage: string | undefined;

  const recorder = {
    delta: (text: string) => {
      if (firstByteMs === undefined && text) firstByteMs = performance.now() - t0;
      assembled += text;
    },
    usage: (u: NormalizedUsage) => {
      usage = u;
    },
    finish: (reason: string) => {
      finish = reason;
    },
  };

  try {
    return await fn(recorder);
  } catch (err: any) {
    if (err?.name === "AbortError") status = "cancelled";
    else {
      status = "error";
      errorMessage = err?.message ?? String(err);
    }
    throw err;
  } finally {
    // Same fire-and-forget guard as patchMethod above.
    try {
      const completedAt = new Date();
      const latencyMs = Math.round(performance.now() - t0);
      const result = getSink().emit({
      requestId,
      conversationId,
      provider: req.provider,
      model: req.model,
      status,
      errorMessage,
      latencyMs,
      timeToFirstByteMs: firstByteMs !== undefined ? Math.round(firstByteMs) : undefined,
      promptTokens: usage?.prompt,
      completionTokens: usage?.completion,
      totalTokens: usage?.total,
      inputPreview: preview(req.inputText ?? "") ?? undefined,
      outputPreview: preview(assembled) ?? undefined,
      metadata: { finishReason: finish, source: "manual" },
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    } satisfies InferenceLogPayload);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) =>
          console.error("[logInference] sink emit rejected", err)
        );
      }
    } catch (err) {
      console.error("[logInference] sink emit threw", err);
    }
  }
}
