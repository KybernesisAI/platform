/**
 * @kybernesis/dispatch — agent-to-agent dispatch for eve agents.
 *
 * Two deployed eve agents talk over a declared edge: the caller mounts a
 * {@link remotePeer} under `agent/subagents/`, the receiver authors its eve
 * channel with {@link dispatchChannel}. Together they give you eve's native
 * `defineRemoteAgent` transport (durable park-and-resume dispatch) with the
 * Kybernesis defaults locked in:
 *
 * - **Principal forwarding on by default** — the receiving agent runs as the
 *   human who asked, so memory scoping, per-user connections, and telemetry
 *   attribution compose across the hop unchanged.
 * - **Peers are pinned, never open** — `dispatchChannel` only accepts an
 *   enumerated list of Vercel projects. The `trustedForwarders: () => true`
 *   footgun (any authenticated caller may assert any identity) is not
 *   expressible through this API.
 * - **URLs come from env** — edges resolve their target at runtime, so
 *   repointing an agent never needs a rebuild.
 *
 * Both deployments must run compatible eve versions: a receiver predating
 * principal forwarding silently drops it and runs the session as the calling
 * app's service identity. Upgrade both ends of an edge together.
 */

export { remotePeer, type RemotePeerOptions } from "./remote-peer.js";
export { type GovernedOptions } from "./governed.js";
export {
  dispatchChannel,
  peerSubject,
  type DispatchChannelOptions,
  type PeerRef,
} from "./channel.js";
