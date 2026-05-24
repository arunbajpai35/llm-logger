// Per-conversation token cap. Returns the spend so far and whether the next
// call should be allowed.
//
// We sum `totalTokens` across SUCCESSFUL inference logs only — failed and
// cancelled calls don't burn tokens (Anthropic / OpenAI don't bill them) so
// they don't count toward the cap. This means a stream of upstream errors
// can't lock out a conversation.

import { prisma } from "./prisma";

export const DEFAULT_CONVERSATION_TOKEN_CAP = Number(
  process.env.CONVERSATION_TOKEN_CAP ?? "200000"
);

export async function checkConversationBudget(
  conversationId: string,
  cap: number = DEFAULT_CONVERSATION_TOKEN_CAP
): Promise<{ allowed: boolean; used: number; cap: number }> {
  const spent = await prisma.inferenceLog.aggregate({
    where: { conversationId, status: "success" },
    _sum: { totalTokens: true },
  });
  const used = Number(spent._sum.totalTokens ?? 0);
  return { allowed: used < cap, used, cap };
}
