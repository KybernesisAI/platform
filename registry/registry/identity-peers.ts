import { arpPeers } from "@kybernesis/identity";

// Every agent this one is PAIRED with on the agent network, as tools — resolved
// from ARP Cloud at the start of each turn.
//
// Pairing in the console is the whole job: the ask_<name>_agent tool appears on the
// next turn and disappears when the connection is revoked. Each message is
// checked against the permissions the other owner granted and logged for both
// sides before it is delivered.
export default arpPeers();
