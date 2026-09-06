// ============================================================
// Extension entry: Plan Mode — enter/exit_plan_mode tools, /plan
// command, persistence, system-prompt injection, and the plan
// tool-call gate (write/edit restrictions while planning).
//
// 20- loads before 30-permission so plan-mode blocks win over
// permission prompts: an edit to a non-plan file in plan mode is
// blocked outright, never surfaced as an approval question.
//
// Filter out this file to drop Plan Mode entirely.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planManager } from "../packages/core/plan";

export default function (pi: ExtensionAPI) {
  // Plan state is managed per-session via file in session directory
  // (see packages/core/plan/commands.ts). Persist on every change so
  // session restore (below) can pick it up.
  planManager.setPersistence((data) => {
    try { pi.appendEntry("lamboy_plan", data); } catch { /* stale ctx */ }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Set plan session directory (for plan file storage)
    try { planManager.setSessionDir(ctx.sessionManager.getSessionDir()); } catch { /* ok */ }

    // Restore plan state from persisted entries, then validate: a stale
    // active plan with no content and no file on disk must not silently
    // trap the session — validateRestoredState() deactivates it.
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "custom" && e.customType === "lamboy_plan" && e.data) {
          planManager.restoreFromData(e.data);
          planManager.validateRestoredState();
          break;
        }
      }
    } catch { /* not critical */ }

    if (planManager.isPlanModeActive()) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }
  });

  // Inject plan context into the system prompt
  pi.on("context", (event, _ctx) => {
    planManager.injectIntoMessages(event.messages);
  });

  // ── tool_call: plan mode restrictions (run BEFORE the permission chain) ──
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName || "";
    const input = (event.input ?? {}) as Record<string, unknown>;
    const filePath = (input.file_path as string) || (input.path as string) || "";
    // Bash command string — forwarded so the read-only whitelist in
    // PlanManager.shouldBlockTool can vet it. Other tools ignore it.
    const bashCommand = (input.command as string) || (input.cmd as string) || (input.script as string) || "";

    if (planManager.shouldBlockTool(toolName, filePath, bashCommand)) {
      // Per-tool deny message (plan-mode-guard-deny.ts parity).
      const planFilePath = planManager.getPlanFilePath();
      const reason = `Plan mode is active. You may only write to the current plan file: ${planFilePath || "(no plan file selected yet)"}. Call exit_plan_mode to exit plan mode before editing other files.`;
      ctx.ui.notify(reason, "warning");
      return { block: true, reason: `Plan Mode: ${reason}` };
    }

    // plan-mode-tool-approve parity: entering plan mode and
    // write/edit targeting the plan file are approved WITHOUT the
    // permission dialog. exit_plan_mode is also approved — its own
    // review panel handles user approval. (plan-mode-tool-approve.ts)
    if (
      toolName === "enter_plan_mode" ||
      toolName === "exit_plan_mode" ||
      (planManager.isPlanModeActive() &&
        (toolName === "write" || toolName === "edit") &&
        planManager.isPlanFilePath(filePath))
    ) {
      return undefined; // allowed, skip permission chain
    }
  });

  planManager.registerTools(pi);
  planManager.registerCommands(pi);
}
