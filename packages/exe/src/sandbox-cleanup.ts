import { defineHook, type HookContext } from "eve/hooks";

/** Permanently remove a sandbox only after eve has recorded a terminal session result. */
export async function deleteTerminalSessionSandbox(ctx: HookContext): Promise<void> {
  try {
    const sandbox = await ctx.getSandbox();
    await sandbox.delete();
  } catch (error) {
    console.warn("Could not delete terminal eve session sandbox; leaving it protected for manual recovery.", {
      agent: ctx.agent.name,
      error,
      sessionId: ctx.session.id,
    });
  }
}

/** Best-effort terminal sandbox cleanup for exe-hosted durable sessions. */
export const terminalSandboxCleanupHook = defineHook({
  events: {
    "session.completed": (_event, ctx) => deleteTerminalSessionSandbox(ctx),
    "session.failed": (_event, ctx) => deleteTerminalSessionSandbox(ctx),
  },
});

export default terminalSandboxCleanupHook;
