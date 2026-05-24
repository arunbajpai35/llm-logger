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
import { patchMethod, extractMessageText } from "./core";

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
      // is true. We merge into whatever the caller already passed so other
      // stream_options (e.g. logprobs config) survive, and an explicit
      // `include_usage: false` from the caller still wins.
      const [params, opts] = args;
      if (!params?.stream) return args;
      return [
        {
          ...params,
          stream_options: { include_usage: true, ...params.stream_options },
        },
        opts,
      ];
    },
    extractRequest: (args) => {
      const params = args[0] ?? {};
      const messages = Array.isArray(params.messages) ? params.messages : [];
      const inputText = messages
        .map((m: any) => `${m.role}: ${extractMessageText(m.content)}`)
        .join("\n");
      return {
        provider: "openai",
        model: params.model ?? "unknown",
        inputText,
        stream: !!params.stream,
      };
    },
    handleNonStreaming: (response: any) => {
      const msg = response?.choices?.[0]?.message;
      // Tool-calling responses have an empty `content` and a `tool_calls`
      // array. Surface a synthetic preview so the dashboard / outputPreview
      // isn't blank.
      let outputText: string = msg?.content ?? "";
      if (!outputText && Array.isArray(msg?.tool_calls)) {
        outputText = msg.tool_calls
          .map((tc: any) => `tool:${tc?.function?.name ?? "?"} ${tc?.function?.arguments ?? ""}`)
          .join(" ");
      }
      return {
        outputText,
        finish: response?.choices?.[0]?.finish_reason,
        usage: response?.usage
          ? {
              prompt: response.usage.prompt_tokens,
              completion: response.usage.completion_tokens,
              total: response.usage.total_tokens,
            }
          : undefined,
      };
    },
    handleStreaming: () => {
      // Parallel tool calls stream interleaved by `index` — chunk A might be
      // {index: 0, fn: "foo"}, chunk B {index: 1, fn: "bar"}, chunk C
      // {index: 0, args: "{x"}, chunk D {index: 1, args: "{y"}. Concatenating
      // by stream order would jumble args across tools. Group by index in a
      // closure that lives for the duration of this stream.
      const toolFnByIndex = new Map<number, string>();
      return {
        parse: (chunk: any) => {
          const delta = chunk?.choices?.[0]?.delta;
          // Tool-using calls stream `delta.tool_calls` with no `delta.content`.
          // Without capturing them, TTFB never fires and outputPreview shows
          // empty for any function-calling request. We surface the tool call's
          // function name + args fragment so the preview is useful.
          let text: string | undefined = delta?.content;
          if (!text && Array.isArray(delta?.tool_calls)) {
            const parts: string[] = [];
            for (const tc of delta.tool_calls) {
              const idx = typeof tc?.index === "number" ? tc.index : 0;
              const name = tc?.function?.name;
              const argsFrag = tc?.function?.arguments;
              if (name) {
                if (!toolFnByIndex.has(idx)) {
                  toolFnByIndex.set(idx, name);
                  parts.push(`tool[${idx}]:${name}`);
                }
              }
              if (argsFrag) {
                parts.push(`[${idx}]${argsFrag}`);
              }
            }
            if (parts.length) text = parts.join(" ");
          }
          return {
            text,
            finish: chunk?.choices?.[0]?.finish_reason ?? undefined,
            usage: chunk?.usage
              ? {
                  prompt: chunk.usage.prompt_tokens,
                  completion: chunk.usage.completion_tokens,
                  total: chunk.usage.total_tokens,
                }
              : undefined,
          };
        },
      };
    },
  });

  return true;
}
