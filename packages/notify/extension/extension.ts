import { defineExtension } from "eve/extension";

/**
 * Tell a person's phone when this agent needs them.
 *
 * Mounted as an extension so every agent gets it the same way it gets its
 * other capabilities, with nothing to configure beyond the credential it
 * already holds for the control plane (KYBERNESIS_AGENT_CREDENTIAL).
 */
export default defineExtension();
