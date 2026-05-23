import { z } from "zod";

export const inferenceLogSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().optional(),
  // Open string — the built-in adapters use "openai" / "groq" / "anthropic",
  // but `logInference` / custom adapters can emit arbitrary provider names
  // (e.g. "internal-vllm", "custom-groq-fetch") so we don't gate that here.
  provider: z.string().min(1),
  model: z.string(),
  status: z.enum(["success", "error", "cancelled"]),
  errorMessage: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  timeToFirstByteMs: z.number().int().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  inputPreview: z.string().optional(),
  outputPreview: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export type InferenceLogInput = z.infer<typeof inferenceLogSchema>;
