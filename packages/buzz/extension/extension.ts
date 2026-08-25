import { defineExtension } from "eve/extension";

/**
 * The agent's hands in Buzz.
 *
 * The bridge in this package gives an agent a voice — it hears mentions and
 * answers as the person who asked. This gives it everything else the platform
 * has: projects, issues, pull requests, patches, repositories, long-form notes,
 * channel canvases, workflows, the activity feed, media.
 *
 * Buzz's own design says an agent acts through its CLI — the harness prompts
 * the agent, "and the agent replies using the Buzz CLI". We replaced the
 * harness half to get governed per-person identity, and for a while shipped
 * only that half: agents could talk in a workspace and do nothing in it, and
 * would say Projects did not exist because nothing had told them otherwise.
 */
export default defineExtension();
