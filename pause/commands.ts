// ============================================================
// Pause / steer commands (adapter, pi extension).
//
// /pause freezes the main agent (tool_call gate) and every swarm
// subagent at their next safe boundary until the overlay is
// released. /steer injects a message into a running subagent's
// steering queue (swarm sessions) — the agent loop drains it after
// the current tool call completes.
// ============================================================

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { swarmState } from "../packages/core/swarm/types";
import { runPauseScreen } from "./screen";

/** All currently steerable task ids: swarm sessions. */
function runningTaskIds(): string[] {
  return [...(swarmState.activeSessions?.keys() ?? [])];
}

export function registerPauseCommands(pi: ExtensionAPI): void {
  // ── /pause — freeze all agents at the next safe boundary ──
  pi.registerCommand("pause", {
    description: "Freeze all agents at the next safe boundary",
    handler: async (_args, ctx) => {
      const ok = await runPauseScreen(ctx);
      if (!ok) {
        try { ctx.ui.notify("Pause requires interactive UI", "error"); } catch { /* ok */ }
      }
    },
  });

  // ── /steer — send a message to a running subagent ──
  pi.registerCommand("steer", {
    description: "Send a message to a running subagent",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
      runningTaskIds().filter((id) => id.startsWith(prefix)).map((id) => ({ value: id, label: id })),
    handler: async (args, ctx) => {
      const m = (args ?? "").trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        try { ctx.ui.notify("Usage: /steer <taskId> <message>", "error"); } catch { /* ok */ }
        return;
      }
      const taskId = m[1];
      const message = m[2];

      // Swarm subagent sessions first.
      const swarmEntry = swarmState.activeSessions?.get(taskId);
      if (swarmEntry?.session) {
        try {
          await swarmEntry.session.steer(message);
          try { ctx.ui.notify(`Steered ${taskId}`, "success"); } catch { /* ok */ }
        } catch (e: unknown) {
          try { ctx.ui.notify(`steer failed: ${e instanceof Error ? e.message : String(e)}`, "error"); } catch { /* ok */ }
        }
        return;
      }

      try { ctx.ui.notify(`steer failed: no running task ${taskId}`, "error"); } catch { /* ok */ }
    },
  });
}
