import { listVaultTool } from "@kybernesis/vault";

// What the signed-in person has saved for a site: labels and handles, never
// the secrets. Nothing for an unattended turn — a vault is someone's.
export default listVaultTool();
