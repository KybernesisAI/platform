// The agent's hands in Buzz: projects, issues, pull requests, patches, repos,
// long-form notes, channel canvases, workflows, the feed, media — everything the
// workspace has beyond talking, which the bridge alone does not provide.
//
// Actions are signed with THIS AGENT's key and appear under its name, so it acts
// as a member with its own standing rather than on behalf of whoever asked. The
// workspace decides what it may do; a refusal from the relay is an answer.
//
// Needs the CLI on the host, once:  npx kybernesis-buzz install-cli
export { default } from "@kybernesis/buzz/extension";
