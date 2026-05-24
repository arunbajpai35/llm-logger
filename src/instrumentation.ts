// Next.js instrumentation entry. Runs once at server boot, BEFORE any route
// handler executes — the right place to install the SDK monkey-patches.
//
// Pattern: this file only routes the call to a runtime-specific impl. The
// actual Node-only code lives in `instrumentation-node.ts` so webpack doesn't
// try to bundle Node-native deps (bullmq, ioredis, etc.) for the edge build.
//
// Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
