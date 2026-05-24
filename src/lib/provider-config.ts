// Single source of truth for "which LLM providers are configured from env?"
//
// The chat route (LLMClient facade) and the auto-chat route (raw OpenAI SDK)
// both need to inspect the same env vars to decide whether to build an
// AzureOpenAI client, a vanilla OpenAI client, or a Groq-baseURL'd OpenAI
// client. Duplicating the if/else chain across routes invites drift — a new
// env var added in one place but not the other would silently break the
// route that didn't get updated.

export interface AzureConfig {
  apiKey: string;
  endpoint: string;
  apiVersion: string;
  deployment: string;
}

export function azureConfig(): AzureConfig | null {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!apiKey || !endpoint || !deployment) return null;
  return {
    apiKey,
    endpoint,
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
  };
}

export function openaiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY || undefined;
}

export function groqApiKey(): string | undefined {
  return process.env.GROQ_API_KEY || undefined;
}
