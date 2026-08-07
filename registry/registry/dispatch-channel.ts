import { dispatchChannel } from "@kybernesis/dispatch";

// Agent-to-agent receiver: accepts calls — and forwarded end-user principals —
// from exactly the peer deployments enumerated here. Fill in the REAL Vercel
// team slug + project name of each caller (what `vercel ls` shows); a peer
// that isn't listed gets a 403. Never widen this to a predicate.
//
// Caller side: drop a remotePeer() file under agent/subagents/ in the OTHER
// agent's repo — see the connect-agents skill in .claude/skills.
//
// Control-plane governed agent? Keep governance in the same walk:
//   dispatchChannel({ trustedPeers, extraAuth: [kybernesisAuth({ issuer, agent })] })
export default dispatchChannel({
  trustedPeers: [
    { teamSlug: "your-team", projectName: "caller-agent" },
  ],
});
