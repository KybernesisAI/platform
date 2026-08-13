import { localMcpTools } from "@kybernesis/local";

// Tools from MCP servers running on the user's OWN computer, reached through
// KYBER Studio's outbound connection.
//
// This is the case a hosted connector cannot cover: a database inside a company
// network, a private repository, an internal API with no ingress. The desktop
// dials out, so nothing has to be exposed to reach it.
//
// Nothing here when the user has no servers set up, or when their desktop is
// closed — a closed laptop means no local tools this turn, not a failed turn.
export default localMcpTools();
