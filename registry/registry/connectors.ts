import { connectorTools } from "@kybernesis/connectors";

// Tools for whatever the person talking has connected in KYBER Studio — Gmail,
// Calendar, Slack, Notion, a custom MCP server, whatever is on their shelf.
//
// Resolved per turn from the identity that authenticated the turn, so one
// colleague's mailbox never becomes a tool in another's conversation, and a
// service connected mid-conversation works on the next message rather than the
// next session.
//
// Costs nothing until it is used: without a control-plane credential the
// resolver returns no tools at all, so an unregistered agent carries no prompt
// weight and raises no errors.
export default connectorTools();
