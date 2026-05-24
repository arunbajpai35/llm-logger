// Verify #1: a browser disconnect during streaming aborts the upstream call
// and the resulting InferenceLog row records `status: "cancelled"` (not
// "success") and a partial outputPreview.
//
// Run: node scripts/verify-cancel.mjs --url http://localhost:3000 --route /api/auto-chat
// Default route: /api/auto-chat. Use /api/custom-chat for the Groq path.

import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const URL = args.url ?? "http://localhost:3000";
const ROUTE = args.route ?? "/api/auto-chat";
const ABORT_AFTER_MS = Number(args.abortMs ?? 600);

console.log(`[verify-cancel] target=${URL}${ROUTE}  abortAfter=${ABORT_AFTER_MS}ms`);

const controller = new AbortController();
const start = performance.now();

// Fire a long-running streaming request, abort midway.
const p = fetch(`${URL}${ROUTE}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message:
      "Write a very long 3000-word detailed essay covering the history of distributed systems, the CAP theorem with examples, eventual consistency, Paxos vs Raft, real-world systems like Cassandra/Spanner/Kafka, and modern serverless architectures. Be exhaustive — include all examples and edge cases.",
  }),
  signal: controller.signal,
});

// Schedule the abort.
setTimeout(() => {
  console.log(`[verify-cancel] aborting at ${Math.round(performance.now() - start)}ms`);
  controller.abort();
}, ABORT_AFTER_MS);

let conversationId;
let bytesReceived = 0;

try {
  const res = await p;
  conversationId = res.headers.get("x-conversation-id");
  console.log(`[verify-cancel] conversationId=${conversationId}`);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesReceived += value.length;
  }
  console.log(`[verify-cancel] stream ended cleanly (${bytesReceived} bytes)`);
} catch (err) {
  if (err.name === "AbortError") {
    console.log(`[verify-cancel] fetch aborted as expected (${bytesReceived} bytes received)`);
  } else {
    console.error(`[verify-cancel] unexpected error:`, err);
    process.exit(1);
  }
}

if (!conversationId) {
  console.error("[verify-cancel] no conversationId — couldn't verify the log");
  process.exit(1);
}

// Give the log a moment to land (fire-and-forget through BullMQ).
console.log("[verify-cancel] waiting 3s for ingest to drain...");
await sleep(3000);

// Pull the conversation back and find the latest InferenceLog. We don't have
// a direct InferenceLog GET endpoint, but we can read the metrics shape via
// /api/conversations/:id (returns messages) and then we'll just print the
// expected verification SQL the human should run.
const convoRes = await fetch(`${URL}/api/conversations/${conversationId}`);
const convo = await convoRes.json();
console.log(`\n[verify-cancel] conversation messages: ${convo.messages?.length ?? 0}`);
console.log(`[verify-cancel] conversation status: ${convo.status}`);

console.log(`\n[verify-cancel] EXPECTED: an InferenceLog row for conversationId ${conversationId}`);
console.log(`[verify-cancel]   - status = "cancelled"`);
console.log(`[verify-cancel]   - outputPreview should be partial (<< a 600-word essay)`);
console.log(`[verify-cancel]   - completionTokens should be small or null`);
console.log(`\nVerification SQL:`);
console.log(
  `  SELECT status, "completionTokens" AS comp_tokens, "outputPreview" FROM "InferenceLog"\n  WHERE "conversationId" = '${conversationId}' ORDER BY "createdAt" DESC LIMIT 1;`
);
