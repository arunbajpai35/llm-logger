// Per-million-token USD prices. Sourced from each provider's public pricing page.
// Snapshot date: 2026-05-21. Update via PR if a provider repriced.
//
// Why a static table: we only need cost USD at log-write time. A live price
// API would add latency + a failure mode on the hot path. Drift between this
// table and reality is bounded to whatever cadence we re-snapshot.

type PriceRow = { input: number; output: number };

const PRICES: Record<string, PriceRow> = {
  // OpenAI
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o": { input: 2.5, output: 10.0 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1": { input: 2.0, output: 8.0 },
  // Azure OpenAI uses the same model names as deployments. Same rate sheet.
  "openai:gpt-4o-mini-azure": { input: 0.15, output: 0.6 },
  // Groq
  "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "groq:llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "groq:mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
  // Alias for /api/custom-chat which posts as provider="custom-groq-fetch"
  // (it's the same upstream, just hit via raw HTTP to demo logInference).
  // Without this alias every custom-chat row gets costUsd: null.
  "custom-groq-fetch:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  // Anthropic (kept here for when the adapter ships).
  "anthropic:claude-3-5-sonnet": { input: 3.0, output: 15.0 },
  "anthropic:claude-3-5-haiku": { input: 0.8, output: 4.0 },
};

export function priceFor(provider: string, model: string): PriceRow | undefined {
  return PRICES[`${provider}:${model}`];
}

// Compute USD cost for one call. Returns null when we can't compute a real
// number — either we don't have a rate for the (provider, model) pair, or
// the call has no usage data (error / cancelled before the usage chunk).
// Returning null instead of 0 keeps the dashboard's SUM honest: $0 means
// "the call legitimately cost nothing" (e.g. fully cached prompt at zero
// rate), not "we don't know."
export function computeCostUsd(opts: {
  provider: string;
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): number | null {
  const rate = priceFor(opts.provider, opts.model);
  if (!rate) return null;
  // If we don't have token counts at all, we can't compute cost. This is the
  // normal case for failed / cancelled calls before the usage chunk arrives.
  if (opts.promptTokens == null && opts.completionTokens == null) return null;
  const inTok = opts.promptTokens ?? 0;
  const outTok = opts.completionTokens ?? 0;
  const cost = (inTok / 1_000_000) * rate.input + (outTok / 1_000_000) * rate.output;
  // Six decimals — sub-cent costs are common.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
