import { connectSlackCredentials } from "@vercel/connect/eve";
import { multiplayerSlackChannel } from "@kybernesis/multiplayer/slack";

// Kybernesis multiplayer: shared Slack threads with per-speaker verified identity,
// attributed context, no-re-mention continuation, and dual-surface (channel vs DM)
// sessions. Set SLACK_CONNECTOR_UID to your Vercel Connect Slack connector
// (create: `vercel connect create slack --triggers`, then re-attach the trigger
// path to /eve/v1/slack).
export default multiplayerSlackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR_UID!),
});
