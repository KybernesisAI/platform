/**
 * @kybernesis/exe — run eve agents on exe.dev VMs.
 *
 * Channel-agnostic by design: this entrypoint covers HOST concerns only —
 * model access, process supervision, and host preflight. Channel bindings live
 * behind subpaths (`@kybernesis/exe/slack`) so an agent on iMessage, Telegram,
 * or no chat surface at all never imports Slack code.
 *
 * What an exe.dev host gives an eve agent:
 * - **Model access with no key on the host** — the LLM integration brokers a
 *   managed gateway, your API key, or a ChatGPT subscription ({@link exeModel}).
 * - **A public HTTPS URL** per VM (`https://<vm>.exe.xyz`, private by default;
 *   `share set-public` to open it) for webhook-based channels.
 * - **Persistent disk** for workflow state, and Docker for sandboxes.
 * - **4-second VM create/clone** via a scoped API token.
 *
 * What you own versus Vercel: route auth (`localDev()` never authenticates
 * under `eve start`), Slack/Photon credentials that Vercel Connect used to
 * broker, and process supervision.
 */

export { exeModel, type ExeModelOptions } from "./model.js";
export {
  hostPreflight,
  type HostPreflightResult,
  type HostCheck,
} from "./preflight.js";
