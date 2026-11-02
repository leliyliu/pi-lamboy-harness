// ============================================================
// Extension entry: Permission — /mode command, mode persistence,
// the approval dialog (shared tabbed component with ask), the
// policy chain (auto/yolo/manual + destructive/sensitive guards),
// and system-prompt injection.
//
// 30- loads after 20-plan (plan blocks take precedence over
// permission prompts) and after 10-pause (a frozen agent never
// reaches the policy chain).
//
// Filter out this file to drop the guard layer entirely.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { permissionManager, approvalViaRpcUi } from "../packages/core/permission";
import { registerPermissionCommands } from "../packages/core/permission/commands";
import { formatDuration } from "../packages/core/permission/timeout.ts";
import { showQuestionDialogOutcome } from "../ask/index";
import { approvalTitleFor } from "../packages/core/ask/types";
import { setAttentionBus } from "../packages/core/attention/index.ts";

export default function (pi: ExtensionAPI) {
  // Bind the cross-extension attention bus used before an approval prompt.
  setAttentionBus(pi.events);

  // ── Permission mode persistence ──
  permissionManager.setPersistence((mode) => {
    try { pi.appendEntry("lamboy_permission", { mode }); } catch { /* stale ctx */ }
  });

  // ── Permission approval dialog: numbered three-way ask (shared with
  // ask_user_question). Per-tool action titles (approval-panel
  // parity); 'once' approves without recording; 'always' records for the
  // session (the old confirm's implicit behavior); deny optionally
  // carries a user reason back to the model.
  //
  // Non-TUI hosts (pi RPC mode: obsidian-pi & other embedding clients)
  // have no working ctx.ui.custom — showQuestionDialog resolves undefined
  // there and every `ask` verdict would be silently denied. Route those
  // through the extension UI protocol primitives (select/input/confirm),
  // which RPC hosts implement.
  //
  // Idle timeout (yolo/auto only, see packages/core/permission/timeout.ts):
  // the panel counts down and closes as `timedOut`, which we turn into an
  // allow-once. Esc still denies — only the timer sets timedOut.
  permissionManager.setApprovalDialog(async (dialogCtx, toolName, title, message, opts) => {
    const timeoutMs = opts?.timeoutMs;
    // Workspace identity (packages/core/workspace): several Paseo workspaces
    // can be blocked on an approval at once, so the prompt must say which one.
    const actionTitle = approvalTitleFor(toolName);
    const workspace = opts?.workspace;
    const workspaceLine = workspace
      ? `📍 ${workspace}${opts?.cwd ? ` · ${opts.cwd}` : ""}`
      : undefined;
    if (dialogCtx?.mode !== "tui") {
      const rpcTitle = workspace ? `${actionTitle} · ${workspace}\n${title}` : `${actionTitle}\n${title}`;
      return approvalViaRpcUi(dialogCtx, toolName, rpcTitle, message, { timeoutMs });
    }

    // Loop so Esc in the "Deny with reason" input returns to the options
    // (the same pattern the plan approval panel uses for its Revise input)
    // instead of ending the whole dialog with a bare deny.
    while (true) {
      const outcome = await showQuestionDialogOutcome(
        dialogCtx,
        {
          question: `${actionTitle}\n${message}`,
          // Dim line under the question: workspace label + the exact cwd.
          body: workspaceLine,
          options: [
            { label: "Allow once", description: "Approve this call only" },
            { label: "Always allow (this session)", description: "Record approval for the rest of the session" },
            { label: "Deny", description: "Block this call" },
            { label: "Deny with reason", description: "Block and tell the agent why" },
          ],
        },
        {
          timeoutMs,
          countdownLabel: timeoutMs
            ? `auto-allow (${formatDuration(timeoutMs)} idle)${opts?.isDestructive ? " — DESTRUCTIVE" : ""}`
            : undefined,
        },
      );
      if (outcome.timedOut) return { decision: "once", timedOut: true };

      const choice = outcome.choice;
      if (choice === "Allow once") return { decision: "once" };
      if (choice === "Always allow (this session)") return { decision: "always" };
      if (choice === "Deny with reason") {
        let reason: string | undefined;
        try {
          reason = (await dialogCtx.ui.input("Reason for denying (optional)", "e.g. don't force-push to main")) || undefined;
        } catch { /* input unavailable */ }
        if (reason === undefined) continue; // Esc in input → back to the options
        return { decision: "deny", reason };
      }
      // undefined (Esc at options) or "Deny" → deny
      return { decision: "deny" };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Permission mode status bar (current mode, before restore)
    const mode = permissionManager.getMode();
    ctx.ui.setStatus("permission-mode", ctx.ui.theme.fg(
      mode === 'auto' ? 'success' : mode === 'yolo' ? 'warning' : 'accent',
      mode
    ));

    // Restore permission mode from persisted entries
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "custom" && e.customType === "lamboy_permission" && e.data?.mode) {
          if (["auto", "yolo", "manual"].includes(e.data.mode)) {
            permissionManager.setMode(e.data.mode);
            const restoredMode = e.data.mode;
            ctx.ui.setStatus("permission-mode", ctx.ui.theme.fg(
              restoredMode === 'auto' ? 'success' : restoredMode === 'yolo' ? 'warning' : 'accent',
              restoredMode
            ));
          }
          break;
        }
      }
    } catch { /* not critical */ }
  });

  // Inject permission/AGENTS.md context into the system prompt
  pi.on("context", (event, _ctx) => {
    permissionManager.injectIntoMessages(event.messages);
  });

  // ── tool_call: permission policy chain (after pause + plan gates) ──
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName || "";
    const input = (event.input ?? {}) as Record<string, unknown>;
    const result = await permissionManager.evaluate(toolName, input, ctx.cwd || process.cwd(), ctx);
    if (result?.block) {
      ctx.ui.notify(`Blocked: ${result.reason}`, "warning");
      return result;
    }
  });

  // ── Register /mode command ──
  registerPermissionCommands(pi, permissionManager);
}
