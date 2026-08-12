import { localShellTool } from "@kybernesis/local";

// The user's OWN machine, reached through KYBER Studio. Studio holds an
// outbound connection to the control plane; these tools queue work on it and
// wait for the answer, so nothing here connects to anything and no port opens.
//
// Consent lives on the desktop, per EFFECT rather than per tool: run-command,
// read-file, write-file, list-directory. local_edit declares write-file and
// local_search declares read-file for exactly that reason — two tools reaching
// the same effect must not need two approvals, and must not be able to dodge
// one.
//
// Sibling files: local_read.ts, local_list.ts, local_search.ts, local_edit.ts,
// local_write.ts. Add only the ones this agent should have.
export default localShellTool();
