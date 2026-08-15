import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Judge model for soft LLM-graded assertions — never the agent under test.
  judge: { model: "anthropic/claude-haiku-4.5" },
  // Real model + real Arcana per turn: generous timeout, gentle concurrency.
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
