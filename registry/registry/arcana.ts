import arcana from "@kybernesis/arcana";

// One brain for shared surfaces, optionally a second for DMs. Hermetic eval
// runs override ARCANA_COMPANY_WORKSPACE to "<client>-eval" (see the evals
// item), which switches to the eval workspace's own key automatically.
const COMPANY = process.env.ARCANA_COMPANY_WORKSPACE ?? "my-company";
const DM = process.env.ARCANA_DM_WORKSPACE ?? COMPANY;

export default arcana({
  apiKey:
    (COMPANY.endsWith("-eval") ? process.env.ARCANA_EVAL_API_KEY : undefined) ??
    process.env.ARCANA_API_KEY!,
  workspace: COMPANY,
  // With @kybernesis/multiplayer, DM sessions carry surface:"dm" — route them
  // to the DM workspace. Harmless (no-op) without multiplayer.
  resolveWorkspace: (ctx) =>
    ctx.session.auth.current?.attributes.surface === "dm" ? DM : undefined,
});
