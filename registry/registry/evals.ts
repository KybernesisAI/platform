import { kybernesisBaseline } from "@kybernesis/evals";

// The Kybernesis baseline QA suite. Configure for this agent, then run with
// `npm run eval` locally and `eve eval --strict --junit .eve/junit.xml` in CI.
//
// Add a hermetic-workspace script to package.json (never point evals at a real
// brain — create a dedicated `<client>-eval` Arcana workspace + key):
//   "eval": "ARCANA_COMPANY_WORKSPACE=<client>-eval ARCANA_DM_WORKSPACE=<client>-eval eve eval"
export default kybernesisBaseline({
  // agentDisplayName: "Atlas",
  // routing: [{ subagent: "finance" }, { subagent: "marketing" }, { subagent: "engineering" }],
});
