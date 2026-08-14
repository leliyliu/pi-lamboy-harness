// ============================================================
// Pause command (adapter, pi extension).
//
// /pause freezes the main agent at its next safe boundary
// (tool_call gate) until the overlay is released.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPauseScreen } from "./screen";

export function registerPauseCommands(pi: ExtensionAPI): void {
  // ── /pause — freeze the agent at the next safe boundary ──
  pi.registerCommand("pause", {
    description: "Freeze all agents at the next safe boundary",
    handler: async (_args, ctx) => {
      const ok = await runPauseScreen(ctx);
      if (!ok) {
        try { ctx.ui.notify("Pause requires interactive UI", "error"); } catch { /* ok */ }
      }
    },
  });
}
