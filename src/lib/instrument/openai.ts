// Auto-instrumentation adapter for the official `openai` SDK.
// Patches OpenAI.Chat.Completions.prototype.create at install time. The same
// patch covers Azure OpenAI (which uses the same class hierarchy) and any
// OpenAI-compatible provider hit via a baseURL override (Groq, Together,
// Fireworks, OpenRouter, vLLM, Ollama, ...).
//
// We use a static `import` (not eval-require) so webpack gives us the *same*
// module instance the route handlers get. With dynamic require under webpack,
// each entry point can resolve `openai` to its own copy of the Completions
// class — patching one wouldn't affect the others.

import OpenAI from "openai";
import { patchMethod } from "./core";

export function instrumentOpenAI(): boolean {
  // Static-imported types: `OpenAI` is the client class; `OpenAI.Chat.Completions`
  // (accessible via the namespace) is what the route handlers actually call.
  const Completions = (OpenAI as any)?.Chat?.Completions;
  if (!Completions?.prototype?.create) {
    console.warn("[instrument:openai] could not locate OpenAI.Chat.Completions.prototype.create");
    return false;
  }

  patchMethod<[any, any?], any>({
    target: Completions,
    method: "create",
    provider: "openai",
    patchArgs: (args) => {
      // Force-enable usage emission on the final chunk for streaming calls.
      // OpenAI only includes `usage` in the stream if stream_options.include_usage
      // is true. Caller's existing options win if they already set this.
      const [params, opts] = args;
      if (params?.stream && !params?.stream_options) {
        return [{ ...params, stream_options: { include_usage: true } }, opts];
      }
      return args;
    },
    extractRequest: (args) => {
      const params = args[0] ?? {};
      const messages = Array.isArray(params.messages) ? params.messages : [];
      const inputText = messages
        .map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n");
      return {
        provider: "openai",
        model: params.model ?? "unknown",
        inputText,
        stream: !!params.stream,
      };
    },
    handleNonStreaming: (response: any) => ({
      outputText: response?.choices?.[0]?.message?.content ?? "",
      finish: response?.choices?.[0]?.finish_reason,
      usage: response?.usage
        ? {
            prompt: response.usage.prompt_tokens,
            completion: response.usage.completion_tokens,
            total: response.usage.total_tokens,
          }
        : undefined,
    }),
    handleStreaming: () => ({
      parse: (chunk: any) => ({
        text: chunk?.choices?.[0]?.delta?.content ?? undefined,
        finish: chunk?.choices?.[0]?.finish_reason ?? undefined,
        usage: chunk?.usage
          ? {
              prompt: chunk.usage.prompt_tokens,
              completion: chunk.usage.completion_tokens,
              total: chunk.usage.total_tokens,
            }
          : undefined,
      }),
    }),
  });

  return true;
}
