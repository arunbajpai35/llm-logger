// Auto-instrumentation public surface.
//
// One-line install at app boot:
//
//   import { installAutoInstrumentation } from "@/lib/instrument";
//   installAutoInstrumentation();
//
// Then any code anywhere in the process that does:
//
//   const openai = new OpenAI({ apiKey: ... });
//   const stream = await openai.chat.completions.create({ ... stream: true });
//
// is automatically logged through the same /api/ingest -> BullMQ -> Postgres
// pipeline. No facade, no adapter, no call-site changes.
//
// To associate calls with a conversation, wrap in `withConversation`:
//
//   await withConversation("conv_abc123", async () => {
//     return openai.chat.completions.create({ ... });
//   });

import { instrumentOpenAI } from "./openai";
import { instrumentAnthropic } from "./anthropic";
import { runCustomInstallers } from "./core";

export {
  withConversation,
  currentConversationId,
  setLogSink,
  // Extension surface for callers who want to instrument their own custom
  // SDK (registerInstrumentation) or wrap an arbitrary async call
  // manually (logInference). See the "Adding a custom provider" section
  // in the README.
  patchMethod,
  registerInstrumentation,
  logInference,
} from "./core";

export function installAutoInstrumentation(): { providers: string[] } {
  const installed: string[] = [];
  if (instrumentOpenAI()) installed.push("openai");
  if (instrumentAnthropic()) installed.push("anthropic");
  installed.push(...runCustomInstallers());
  console.log(`[instrument] installed: ${installed.join(", ") || "(none)"}`);
  return { providers: installed };
}
