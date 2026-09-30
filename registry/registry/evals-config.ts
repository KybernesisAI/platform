import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Judge model for soft LLM-graded assertions — never the agent under test.
  // eve ≥0.62 grades with an EVALUATION model; a string id resolves through the
  // AI Gateway's evaluation API, and jev is the one it carries natively.
  judge: { model: "typesafe-ai/jev" },
  // Real model + real Arcana per turn: generous timeout, gentle concurrency.
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
