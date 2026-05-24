/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // Next.js 14.2 still needs this flag to load `src/instrumentation.ts`.
    // Stable (flag removed) in Next.js 15.
    instrumentationHook: true,
    // These packages are Node-only (CommonJS, native deps, fs/path imports).
    // The instrumentation hook transitively pulls them in; without this
    // listing webpack tries to bundle them for the edge runtime build and
    // fails on `Can't resolve 'path'`.
    //
    // `openai` is also listed because the monkey-patch in
    // `src/lib/instrument/openai.ts` mutates
    // `OpenAI.Chat.Completions.prototype.create`. If webpack bundles the
    // SDK separately into each route chunk, the patched prototype and the
    // route's prototype are different objects and the patch never fires
    // when the route calls `client.chat.completions.create(...)`. Marking
    // openai as external forces a runtime `require("openai")` from a
    // single Node module cache, so the patch reaches every caller.
    serverComponentsExternalPackages: [
      "bullmq",
      "ioredis",
      "@prisma/client",
      "openai",
    ],
  },
};

export default nextConfig;
