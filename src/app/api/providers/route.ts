import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const providers: string[] = [];
  if (
    process.env.OPENAI_API_KEY ||
    (process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_ENDPOINT &&
      process.env.AZURE_OPENAI_DEPLOYMENT)
  ) {
    providers.push("openai");
  }
  if (process.env.GROQ_API_KEY) providers.push("groq");
  return NextResponse.json({ providers });
}
