import { approveSpendRequestTool } from "@kybernesis/payments";

// The approval moment as one durable call: shows the purchase (merchant, total,
// Approve-in-Link button), waits for the person, returns Link's real status.
export default approveSpendRequestTool();
