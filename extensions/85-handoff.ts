// ============================================================
// Extension entry: Handoff — transfer context to a new focused
// session instead of lossy compaction.
//
// Three triggers (structure mirrors ogulcancelik/pi-handoff; the
// execution path follows the official upstream example — see
// handoff/commands.ts header for why that matters):
//
//   1. /handoff <goal>     user-initiated: one dedicated summarization
//                           call → editor review → new session (parent-
//                           linked, prompt prefilled)
//   2. handoff tool         agent-authored: the agent (which has the
//                           context) writes the full handoff prompt
//                           itself, saved as a custom entry; at turn_end
//                           the user is pointed at /handoff which picks
//                           up the draft without regenerating
//   3. context guard        at 90% usage (turn_end) ask once per session
//                           whether to handoff; confirm → editor
//                           prefilled with "/handoff "
//
// Design notes (evidence in plans/2026-09-13-handoff-extension.md):
//   - The tool does NOT start the new session itself: ExtensionContext
//     has no newSession (types.d.ts:372) and dispatching the command
//     from inside tool execution would run session-control work mid-
//     turn (agent-session.js:826 executes extension commands
//     immediately, even while streaming). All session switching stays
//     inside the command handler.
//   - pi 0.85.x has no built-in session_query tool (verified), so the
//     handoff prompt references the parent session's JSONL path.
//   - Guard is once-per-session; "No" persists via a custom entry so
//     reloads keep the suppression.
//
// Escape hatches:
//   PI_LAMBOY_HANDOFF=0          disable the whole extension
//   PI_LAMBOY_HANDOFF_GUARD=0    disable only the context guard
//   PI_LAMBOY_HANDOFF_THRESHOLD  guard trigger percent (10–100)
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHandoffCommands } from "../handoff/commands.ts";
import {
  guardConfigFromEnv,
  HANDOFF_DRAFT_TYPE,
  HANDOFF_GUARD_STATE_TYPE,
  isGuardSuppressed,
} from "../packages/core/handoff/guard.ts";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_LAMBOY_HANDOFF === "0") return;

  registerHandoffCommands(pi);

  // ── handoff tool — agent writes the prompt itself ──
  // Unlike the deprecated reference package, this tool never touches
  // sessions; it parks the draft and hands control to the user, who
  // confirms through /handoff (the command flow owns newSession).
  pi.registerTool({
    name: "handoff",
    label: "Handoff",
    description:
      "Hand the task over to a fresh session. Write the complete handoff briefing prompt " +
      "yourself (context, decisions, files, next task) — it is the only briefing the next " +
      "session gets.",
    promptSnippet: "handoff: hand the task over to a fresh session with a written briefing",
    promptGuidelines: [
      "Use handoff only when the user explicitly asks to hand off / transfer to a new session, or when context is nearly exhausted and the user agrees to a handoff.",
      "Before calling handoff, write a complete self-contained briefing prompt: context, decisions, files involved, and the next task — the next session sees nothing else.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Complete handoff prompt for the next session: context, decisions, files, and the task. Self-contained.",
        },
      },
      required: ["prompt"],
    },
    async execute(_toolCallId: string, params: { prompt: string }, _signal, _onUpdate, ctx) {
      pi.appendEntry(HANDOFF_DRAFT_TYPE, { prompt: params.prompt, createdAt: new Date().toISOString() });
      pendingDraftHandoff = true;
      try {
        ctx.ui.notify("Handoff draft saved — /handoff after this turn to review & switch", "info");
      } catch { /* non-TUI: fine */ }
      return {
        details: {},
        content: [{
          type: "text",
          text:
            "Handoff draft saved. Do NOT start new work. Tell the user the draft is ready: " +
            "they review it by running /handoff (no arguments), which opens the draft for " +
            "editing and starts the new session on confirmation.",
        }],
      };
    },
  });

  // ── context guard — once per session at high usage ──
  const guard = guardConfigFromEnv();
  let guardPrompted = false;
  let pendingDraftHandoff = false;

  pi.on("session_start", (_event, ctx) => {
    guardPrompted = isGuardSuppressed(ctx.sessionManager.getBranch() as never[]);
    pendingDraftHandoff = false;
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Draft was written during this turn: point the user at /handoff and
    // prefill the editor — one keystroke to confirm. (Command dispatch
    // from an event handler is deliberately avoided: session control
    // must stay in user-initiated command context.)
    if (pendingDraftHandoff) {
      pendingDraftHandoff = false;
      try {
        ctx.ui.setEditorText("/handoff");
      } catch { /* ok */ }
      return;
    }

    if (!guard.enabled || guardPrompted) return;
    if (!ctx.hasUI) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.percent < guard.thresholdPercent) return;

    guardPrompted = true;
    const pct = Math.round(usage.percent);

    try {
      const choice = await ctx.ui.select(
        `Context at ${pct}% — handoff to a new session?`,
        ["Yes, prepare handoff", "No, keep this session"],
      );

      if (choice === "Yes, prepare handoff") {
        ctx.ui.setEditorText("/handoff ");
        ctx.ui.notify("Type your goal for the new session, then submit.", "info");
      } else if (choice) {
        // Explicit "No": suppress for the rest of this session, durable
        // across reloads.
        pi.appendEntry(HANDOFF_GUARD_STATE_TYPE, { suppressed: true, reason: "declined" });
      }
      // No choice (dialog dismissed): stay silent this session but allow
      // a later explicit prompt to try again in a future session.
    } catch {
      // Dialog unavailable (e.g. rpc quirks) — never break the turn.
      guardPrompted = false;
    }
  });
}
