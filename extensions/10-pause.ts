// ============================================================
// Extension entry: Pause — /pause command + process-global
// pause gate wiring at the tool-call boundary.
//
// Numeric prefix = load order (pi loads directory entries in
// lexical order). 10- MUST stay the first tool_call handler:
// the pause gate parks the agent before plan/permission gates
// run, so a frozen agent never evaluates (or asks about) the
// next tool call.
//
// Filter out this file (object-form `extensions` in settings)
// to drop /pause and the freeze capability.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentPauseGate } from "../packages/core/pause/gate";
import { registerPauseCommands } from "../pause/commands";

export default function (pi: ExtensionAPI) {
  // Freeze the main agent at its next safe boundary. The tool_call
  // event carries no AbortSignal (pi types.ts:850-897), so a cancel
  // requested while paused waits for release — the release key is
  // always available, no deadlock.
  pi.on("tool_call", async (_event, _ctx) => {
    await agentPauseGate.waitUntilResumed(undefined, "tool_call");
    return undefined;
  });

  // ── /pause — freeze the agent at the next safe boundary ──
  registerPauseCommands(pi);
}
