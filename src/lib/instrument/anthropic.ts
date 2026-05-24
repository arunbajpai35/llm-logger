// Auto-instrumentation adapter for the official `@anthropic-ai/sdk` package.
// Patches Anthropic.Messages.prototype.create. Conditional on the SDK being
// installed — silently skips if it isn't, so the rest of the framework keeps
// working in an OpenAI-only deployment.
//
// This adapter exists primarily to prove the framework handles a genuinely
// different SDK shape (separate `system` field, different message/content
// structure, different stream event names, different token field names).
// Adding Google Gen AI or AWS Bedrock follows the same ~40-LOC pattern.

import { patchMethod, extractMessageText } from "./core";

export function instrumentAnthropic(): boolean {
  let mod: any;
  try {
    // Hide the require from webpack's static analysis. Anthropic is an
    // optional peer dep — if the user hasn't installed it we silently skip,
    // and we don't want the bundler to drag it in or warn at build time.
    // eslint-disable-next-line no-eval
    const dynamicRequire: NodeRequire = eval("require");
    mod = dynamicRequire("@anthropic-ai/sdk");
  } catch {
    return false;
  }
  const Anthropic = mod.default ?? mod.Anthropic ?? mod;
  const Messages = Anthropic?.Messages;
  if (!Messages?.prototype?.create) {
    console.warn("[instrument:anthropic] could not locate Anthropic.Messages.prototype.create");
    return false;
  }

  patchMethod<[any, any?], any>({
    target: Messages,
    method: "create",
    provider: "anthropic",
    extractRequest: (args) => {
      const params = args[0] ?? {};
      const system = typeof params.system === "string" ? `system: ${params.system}\n` : "";
      const messages = Array.isArray(params.messages) ? params.messages : [];
      const body = messages
        .map((m: any) => `${m.role}: ${extractMessageText(m.content)}`)
        .join("\n");
      return {
        provider: "anthropic",
        model: params.model ?? "unknown",
        inputText: system + body,
        stream: !!params.stream,
      };
    },
    handleNonStreaming: (response: any) => {
      // Anthropic returns content as an array of blocks; we concatenate text blocks.
      const text = Array.isArray(response?.content)
        ? response.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
        : "";
      return {
        outputText: text,
        finish: response?.stop_reason,
        usage: response?.usage
          ? {
              prompt: response.usage.input_tokens,
              completion: response.usage.output_tokens,
              total: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
            }
          : undefined,
      };
    },
    handleStreaming: () => ({
      // Anthropic streaming events:
      //   - content_block_delta { delta: { type: "text_delta", text: "..." } }
      //   - message_delta       { delta: { stop_reason }, usage: { output_tokens } }
      //   - message_start       { message: { usage: { input_tokens } } }
      parse: (event: any) => {
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          return { text: event.delta.text };
        }
        if (event?.type === "message_start" && event.message?.usage) {
          return {
            usage: {
              prompt: event.message.usage.input_tokens ?? 0,
              completion: 0,
              total: event.message.usage.input_tokens ?? 0,
            },
          };
        }
        if (event?.type === "message_delta") {
          const out: any = {};
          if (event.delta?.stop_reason) out.finish = event.delta.stop_reason;
          if (event.usage) {
            // Anthropic only sends output_tokens here; combine with input_tokens
            // we may have captured from message_start. Caller can recompute total.
            out.usage = {
              prompt: 0,
              completion: event.usage.output_tokens ?? 0,
              total: event.usage.output_tokens ?? 0,
            };
          }
          return out;
        }
        return {};
      },
    }),
  });

  return true;
}
