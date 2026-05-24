// Node-only side of the instrumentation hook. Imported via dynamic import
// from `instrumentation.ts` so this module (and everything it transitively
// touches — BullMQ, ioredis, Prisma) is only ever loaded in the Node.js
// runtime build, never the edge build.
//
// This is the seam where the LLM SDK monkey-patches get installed at boot.

import { installAutoInstrumentation } from "./lib/instrument";

installAutoInstrumentation();
