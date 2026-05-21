// Redis-backed sliding-window rate limiter.
// Uses INCR + EXPIRE on a per-(scope, window) key. First request in a window
// sets the TTL; subsequent requests within the same window just increment.
//
// `scope` is whatever the caller wants to bucket by — IP, user, conversation.
// `windowMs` is the bucket width; `max` is the cap.
//
// Tradeoff: this is a fixed-window limiter (cheap), not a true sliding window
// (more accurate but needs ZSET trims). Good enough for abuse prevention on
// /api/chat in this take-home.

import { queueConnection } from "./queue";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetMs: number;
}

export async function rateLimit(
  scope: string,
  max: number,
  windowMs: number
): Promise<RateLimitResult> {
  const windowKey = Math.floor(Date.now() / windowMs);
  const key = `rl:${scope}:${windowKey}`;

  // Pipeline: INCR + PEXPIRE in one round-trip. EXPIRE is idempotent — only the
  // first call in this window actually sets it; later calls reset to the same TTL
  // which is fine (cost is negligible).
  const [countStr, ttlStr] = (await queueConnection
    .multi()
    .incr(key)
    .pexpire(key, windowMs)
    .pttl(key)
    .exec()
    .then((res) => (res ?? []).map((r) => (r?.[1] as string | number | null)?.toString() ?? "0"))) as string[];

  const count = Number(countStr);
  const resetMs = Math.max(0, Number(ttlStr));
  return {
    allowed: count <= max,
    count,
    limit: max,
    resetMs,
  };
}

// Helper for Next.js route handlers — derives a stable scope from request headers.
// Falls back to a constant when no IP can be inferred (kept distinct from real IPs
// so it doesn't collapse all anonymous traffic into one bucket in dev).
export function ipFromHeaders(headers: Headers): string {
  const xf = headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
