import arcana from "@kybernesis/arcana";

// One brain for shared surfaces, optionally a second for DMs. Hermetic eval
// runs override ARCANA_COMPANY_WORKSPACE to "<client>-eval", which switches
// to the eval workspace's own key automatically.
// No placeholder fallback. A default here does not prevent a mistake, it
// hides one: memory silently addresses a workspace nobody owns, and the agent
// looks like it has amnesia rather than like it is misconfigured. Set with
// `kyb arcana`.
const COMPANY = process.env.ARCANA_COMPANY_WORKSPACE;
if (!COMPANY) {
  throw new Error(
    "ARCANA_COMPANY_WORKSPACE is not set — run `kyb arcana` to set the workspace and its key.",
  );
}
const DM = process.env.ARCANA_DM_WORKSPACE ?? COMPANY;

export default arcana({
  apiKey:
    (COMPANY.endsWith("-eval") ? process.env.ARCANA_EVAL_API_KEY : undefined) ??
    process.env.ARCANA_API_KEY!,
  workspace: COMPANY,
  // DM sessions carry surface:"dm" via @kybernesis/multiplayer.
  resolveWorkspace: (ctx) =>
    ctx.session.auth.current?.attributes.surface === "dm" ? DM : undefined,
});
