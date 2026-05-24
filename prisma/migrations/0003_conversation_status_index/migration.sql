-- CreateIndex
-- Covers the per-conversation token-budget query in src/lib/budget.ts
-- (`WHERE conversationId = ? AND status = 'success'`).
CREATE INDEX "InferenceLog_conversationId_status_idx"
  ON "InferenceLog"("conversationId", "status");
