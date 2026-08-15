import { governedPeers } from "@kybernesis/dispatch";

// Every agent this one is ALLOWED to call, as tools — resolved from the control
// plane at the start of each turn.
//
// Granting an edge in the admin is the whole job: the tool appears on the next
// turn and disappears when the edge is revoked, with no file to write and no
// redeploy. Nothing here names a peer, because naming peers in code is what
// made a granted permission useless until someone shipped a change.
//
// Note what this trades away. These calls carry THIS agent's identity, so the
// peer answers as if another agent asked. Where a peer reaches personal data
// and should answer as the human instead, declare that one with remotePeer()
// under agent/subagents/ — it forwards the principal, and the file is worth it
// there.
export default governedPeers();
