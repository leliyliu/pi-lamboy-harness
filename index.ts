/**
 * Personal pi harness — Goal lifecycle, Plan gate, Permission guards,
 * Ask, Todo, Pause, TUI, Truncation.
 */

// ============================================================
// Entry Point — registers tools and commands
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { goalManager } from "./packages/core/goal";
import type { PersistencePort } from "./packages/core/ports";
import { planManager } from "./packages/core/plan";
import { permissionManager, approvalViaRpcUi } from "./packages/core/permission";
import { registerPermissionCommands } from "./packages/core/permission/commands";
import { registerAskUserQuestion, showQuestionDialog } from "./ask/index";
import { approvalTitleFor } from "./packages/core/ask/types";
import { shouldTruncate, truncationPathFor, buildTruncatedPreview, truncationThresholdFor } from "./packages/core/truncation/index";
import { registerTodoList, registerTodoReminders, bindTodoSession, clearTodoSession, restoreTodos, rt, persist, refreshWidget, togglePanel, syncTodoAutoClearTimer } from "./todo/index";
import { phasesToMarkdown, markdownToPhases, applyOp, TodoPhase, TodoItem } from "./packages/core/todo/types";
import { registerTui, setTuiBadgeProvider } from "./tui/index";
import { agentPauseGate } from "./packages/core/pause/gate";
import { registerPauseCommands } from "./pause/commands";
import { agentLifecycle } from "./packages/core/agent-lifecycle/index.ts";

const GOAL_ENTRY_TYPE = "muselinn_goal";

export default function (pi: ExtensionAPI) {
  // ── Goal persistence: save on every change ──
  // Note: pi/ctx go stale after session replacement (newSession/fork/reload
  // or process teardown in pi -p). Persistence callbacks may fire from
  // timers after that, so guard every appendEntry.
  // Reads always resolve through the freshest ctx we've seen.
  let latestCtx: any = null;
  const persistencePort: PersistencePort = {
    append: (entryType, data) => {
      try { pi.appendEntry(entryType, data); } catch { /* stale ctx */ }
    },
    entries: () => {
      try { return latestCtx?.sessionManager?.getEntries?.() ?? []; } catch { return []; }
    },
  };
  goalManager.bindPersistence(persistencePort);

  // ── Plan mode: inject plan context + tool restrictions ──
  // Plan state is managed per-session via file in session directory (see plan/commands.ts)
  // Persist plan state on every change so session restore (below) can pick it up.
  planManager.setPersistence((data) => {
    try { pi.appendEntry("muselinn_plan", data); } catch { /* stale ctx */ }
  });

  // ── Permission mode persistence ──
  permissionManager.setPersistence((mode) => {
    try { pi.appendEntry("muselinn_permission", { mode }); } catch { /* stale ctx */ }
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
  permissionManager.setApprovalDialog(async (dialogCtx, toolName, title, message) => {
    if (dialogCtx?.mode !== "tui") {
      return approvalViaRpcUi(dialogCtx, toolName, `${approvalTitleFor(toolName)}\n${title}`, message);
    }

    // Loop so Esc in the "Deny with reason" input returns to the options
    // (the same pattern the plan approval panel uses for its Revise input)
    // instead of ending the whole dialog with a bare deny.
    while (true) {
      const choice = await showQuestionDialog(dialogCtx, {
        question: `${approvalTitleFor(toolName)}\n${title}: ${message}`,
        options: [
          { label: "Allow once", description: "Approve this call only" },
          { label: "Always allow (this session)", description: "Record approval for the rest of the session" },
          { label: "Deny", description: "Block this call" },
          { label: "Deny with reason", description: "Block and tell the agent why" },
        ],
      });
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

  // ── session_start: restore goal + plan from persisted entries + set status bar ──
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    // Set plan session directory (for plan file storage)
    try { planManager.setSessionDir(ctx.sessionManager.getSessionDir()); } catch { /* ok */ }

    // Refresh model catalog once at startup (Pi 0.80.8 async refresh).
    // Fire-and-forget: this handler runs inside init()'s awaited session_start
    // emit, so awaiting a network refresh here blocks the TUI input loop when
    // the catalog fetch stalls (no signal/timeout). Pi's own run() already
    // refreshes in the background after init(), so startup never needs to
    // wait on the network.
    void ctx.modelRegistry?.refresh?.().catch(() => {});

    // Restore goal + plan BEFORE the status-bar section so restored state is
    // reflected in the badges below.
    // Restore goal from session custom entries (latest wins; a "complete"
    // entry is a tombstone — the goal ended and is not restorable).
    // restoreFromData merges counters monotonically, so a stale entry can
    // never pull turns/tokens/wall-clock backwards.
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "custom" && e.customType === GOAL_ENTRY_TYPE && e.data) {
          if (e.data.status !== "complete") goalManager.restoreFromData(e.data);
          break;
        }
      }
    } catch { /* not critical */ }

    // Restore plan state from persisted entries, then validate: a stale
    // active plan with no content and no file on disk must not silently
    // trap the session — validateRestoredState() deactivates it, and the
    // badge section below then shows no badge.
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "custom" && e.customType === "muselinn_plan" && e.data) {
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
    // Permission mode status bar
    const mode = permissionManager.getMode();
    ctx.ui.setStatus("permission-mode", ctx.ui.theme.fg(
      mode === 'auto' ? 'success' : mode === 'yolo' ? 'warning' : 'accent',
      mode
    ));
    // Goal status bar
    const goalBadge = goalManager.buildFooterBadge();
    if (goalBadge) {
      const color = goalManager.getFooterBadgeColor();
      ctx.ui.setStatus("goal", ctx.ui.theme.fg(color, goalBadge));
    }

    // Agent lifecycle badge ([3 agents running])
    const lifecycleCount = agentLifecycle.getActiveCount();
    ctx.ui.setStatus("lifecycle-agent-count", lifecycleCount > 0
      ? ctx.ui.theme.fg("accent", `[${lifecycleCount} agents running]`)
      : undefined
    );
    // Restore the todo panel (before binding so the first refresh shows it)
    try {
      restoreTodos(ctx.sessionManager.getEntries());
      syncTodoAutoClearTimer();
    } catch { /* ok */ }
    try {
      bindTodoSession(ctx, (type, data) => { try { pi.appendEntry(type, data); } catch { /* stale ctx */ } });
    } catch { /* ok */ }
    try {
      refreshWidget();
    } catch { /* ok */ }

    // Restore permission mode from persisted entries
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "custom" && e.customType === "muselinn_permission" && e.data?.mode) {
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

    // ── Agent lifecycle tracking reset ──
    try { agentLifecycle.reset(); } catch { /* ok */ }
  });

  // ── session_shutdown: clear todo state ──
  pi.on("session_shutdown", () => {
    try { clearTodoSession(); } catch { /* stale ctx */ }
  });

  // ── session_before_compact: preserve goal across compaction (@narumitw style) ──
  pi.on("session_before_compact", (event, _ctx) => {
    const goal = goalManager.getGoal();
    if (goal && goal.status === "active") {
      // @narumitw/pi-goal style: preserve active goal across compaction
      // Goal remains active, no changes needed
      console.log(`[goal] Preserving active goal across compaction: ${goal.objective.slice(0, 50)}`);
    }
  });

  // ── session_compact: handle overflow recovery ──
  pi.on("session_compact", (event, _ctx) => {
    const goal = goalManager.getGoal();
    if (!goal) return;

    // Context overflow recovery: auto-block goal
    if (event.reason === "overflow" && goal.status === "active") {
      goalManager.block("Context overflow", "runtime");
      _ctx.ui.notify("Goal blocked: context overflow", "warning");
    }

    // Preserve goal across compaction (all reasons)
    // @narumitw/pi-goal style: goal stays active, continues after compaction
  });

  // ── context: inject goal + plan into system prompt ──
  pi.on("context", (event, _ctx) => {
    goalManager.injectIntoMessages(event.messages);
    planManager.injectIntoMessages(event.messages);
    permissionManager.injectIntoMessages(event.messages);
  });

  // ── Helper: update goal status bar (pure display refresh) ──
  // This runs on the 1s badge ticker and on turn_end, so it must render
  // in-memory state only — no restore-from-entries here. Restore happens at
  // session_start and (restore-if-empty) at goal tool entry points; doing it
  // on every tick risks swapping newer in-memory state for a stale entry.
  function updateGoalStatusBar(ctx: any) {
    latestCtx = ctx;
    const badge = goalManager.buildFooterBadge();
    if (badge) {
      const color = goalManager.getFooterBadgeColor();
      ctx.ui.setStatus("goal", ctx.ui.theme.fg(color, badge));
    } else {
      ctx.ui.setStatus("goal", undefined);
    }

    // Agent lifecycle badge
    const lifecycleCount = agentLifecycle.getActiveCount();
    ctx.ui.setStatus("lifecycle-agent-count", lifecycleCount > 0
      ? ctx.ui.theme.fg("accent", `[${lifecycleCount} agents running]`)
      : undefined
    );
  }

  // ── Goal badge wall-clock: 1s tick while a goal is active ──
  // The badge shows live duration (footer parity); between turn
  // events it would otherwise go stale. Extra renders are coalesced by
  // pi-tui's 16ms cap; unref'd so `pi -p` is never kept alive by it.
  const goalBadgeTicker = setInterval(() => {
    if (!latestCtx) return;
    const g = goalManager.getGoal();
    if (!g || g.status !== "active") return;
    try { updateGoalStatusBar(latestCtx); } catch { /* stale ctx */ }
  }, 1000);
  goalBadgeTicker.unref?.();

  // ── turn_end: record token usage + budget check (pi-codex-goal style) ──
  // ── tool_result: spill oversized outputs to disk (toolResultTruncation)
  // A runaway log must not eat the context window; the full text lands in
  // <sessionDir>/tool-results/ and the model gets a preview + output_path.
  pi.on("tool_result", (event: any, ctx: any) => {
    try {
      const content = event?.content;
      if (!Array.isArray(content)) return undefined;
      let changed = false;
      // Window-aware spill threshold (issue #2): 1M-context models keep
      // more tool output in-context instead of forcing a read round-trip.
      const truncationThreshold = truncationThresholdFor(ctx?.model?.contextWindow);
      const out = content.map((part: any) => {
        if (part?.type !== "text" || typeof part.text !== "string" || !shouldTruncate(part.text, truncationThreshold)) return part;
        let base: string;
        try { base = ctx?.sessionManager?.getSessionDir?.() || path.join(os.tmpdir(), "pi-muselinn-harness"); }
        catch { base = path.join(os.tmpdir(), "pi-muselinn-harness"); }
        const p = truncationPathFor(base, String(event.toolName ?? "tool"), String(event.toolCallId ?? Date.now()));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, part.text, "utf8");
        changed = true;
        return { ...part, text: buildTruncatedPreview(part.text, p) };
      });
      if (changed) return { content: out };
    } catch { /* never break tool results */ }
    return undefined;
  });

  pi.on("turn_end", (event, _ctx) => {    const msg = event.message as any;
    if (msg?.role === "assistant" && msg?.usage) {
      const tokens = (msg.usage.input || 0) + (msg.usage.output || 0);
      if (tokens > 0) {
        const { crossedBudget } = goalManager.recordTurn(tokens);
        if (crossedBudget) {
          _ctx.ui.notify("Goal budget exceeded — goal blocked.", "warning");
        }
        updateGoalStatusBar(_ctx);
      }
    }

    // Detect context overflow in assistant messages
    if (msg?.role === "assistant" && msg?.stopReason === "error") {
      const errorMsg = msg?.errorMessage || "";
      if (/context|overflow|too many tokens/i.test(errorMsg)) {
        goalManager.block("Context overflow", "runtime");
        _ctx.ui.notify("Goal blocked: context overflow", "warning");
      }
    }

    // Detect provider limit errors (429)
    if (msg?.role === "assistant" && msg?.stopReason === "error") {
      const errorMsg = msg?.errorMessage || "";
      goalManager.detectProviderLimitError(errorMsg);
    }

    // Pause goal on user interrupt. TurnEndEvent carries no
    // signal in pi 0.83 (types.d.ts:555-560); older pi may include it.
    if ((event as { signal?: AbortSignal }).signal?.aborted) {
      goalManager.pauseOnInterrupt("User interrupted");
    }
  });

  // ── Register goal tools and commands (from goal/ module) ──
  goalManager.registerTools(pi);
  registerAskUserQuestion(pi);
  registerTodoList(pi);
  registerTodoReminders(pi);
  goalManager.registerCommands(pi);

  // ── Register plan tools and commands (from plan/ module) ──
  planManager.registerTools(pi);
  planManager.registerCommands(pi);

  // ── Register permission commands ──
  registerPermissionCommands(pi, permissionManager);

  // ── Register /todo slash command ──
  registerTodoCommand(pi);

  // ── tool_call: permission policy chain + plan mode restrictions ──
  pi.on("tool_call", async (event, ctx) => {
    // Pause gate: freeze the main agent at its next safe boundary. The
    // tool_call event carries no AbortSignal (pi types.ts:850-897), so a
    // cancel requested while paused waits for release — the release key is
    // always available, no deadlock.
    await agentPauseGate.waitUntilResumed(undefined, "tool_call");
    const toolName = event.toolName || "";
    const input = (event.input ?? {}) as Record<string, unknown>;

    const filePath = (input.file_path as string) || (input.path as string) || "";
    // Bash command string — forwarded to plan-mode gate so the read-only
    // whitelist in PlanManager.shouldBlockTool can vet it. Other tools ignore
    // this 3rd (optional) arg.
    const bashCommand = (input.command as string) || (input.cmd as string) || (input.script as string) || "";

    // Plan mode restrictions (checked first, before policy chain)
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
    
    // 16-level permission policy chain
    const result = await permissionManager.evaluate(toolName, input, ctx.cwd || process.cwd(), ctx);
    if (result?.block) {
      ctx.ui.notify(`Blocked: ${result.reason}`, "warning");
      return result;
    }
  });

  // ── Pause command (freeze at the next safe boundary) ──
  registerPauseCommands(pi);

  // ── TUI: boxed/compact editor chrome + /tui ──
  try { registerTui(pi); } catch { /* TUI chrome must never break extension load */ }

  // Plan-mode badge on the editor's top border (lazy, cheap in-memory
  // check; reads planManager's state without coupling tui → plan).
  try {
    setTuiBadgeProvider(() => (planManager.isPlanModeActive() ? " plan " : undefined));
  } catch { /* badge is cosmetic */ }

  // ============================================================
  // Interactive Tools (rpiv-ask-user-question provides ask_user_question)
  // ============================================================
}

// ── /todo slash command ────────────────────────────────────────

/**
 * Register the /todo user slash command for manual todo management.
 * Call after registerTodoList.
 */
export function registerTodoCommand(pi: any): void {
  pi.registerCommand("todo", {
    description: "Manage todo list (append / start / done / drop / rm / import / export / copy / edit)",
    usage: [
      "/todo                              Show todos as Markdown",
      "/todo import [<path>]              Replace todos from file (default: TODO.md)",
      "/todo export [<path>]              Export todos to file (default: TODO.md)",
      "/todo copy                         Print todos as Markdown to conversation",
      "/todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
      "/todo start  <task>                Mark task in_progress (fuzzy match)",
      "/todo done   [<task|phase>]        Mark task/phase/all completed",
      "/todo drop   [<task|phase>]        Mark task/phase/all abandoned",
      "/todo rm     [<task|phase>]        Remove task/phase/all",
      "/todo edit                         Hint: use export then import",
      "/todo toggle                       Expand/collapse the todo panel",
    ].join("\n"),
    getArgumentCompletions: (prefix: string) => {
      const subcmds = [
        { value: "import", label: "/todo import", description: "Replace todos from file" },
        { value: "export", label: "/todo export", description: "Export todos to file" },
        { value: "copy",   label: "/todo copy",   description: "Print todos as Markdown" },
        { value: "append", label: "/todo append", description: "Append a task" },
        { value: "start",  label: "/todo start",  description: "Mark task in_progress" },
        { value: "done",   label: "/todo done",   description: "Mark task/phase/all completed" },
        { value: "drop",   label: "/todo drop",   description: "Mark task/phase/all abandoned" },
        { value: "rm",     label: "/todo rm",     description: "Remove task/phase/all" },
        { value: "edit",   label: "/todo edit",   description: "Open in editor" },
        { value: "toggle", label: "/todo toggle", description: "Expand/collapse the todo panel" },
      ];
      if (!prefix) return subcmds;
      const lower = prefix.toLowerCase();
      return subcmds.filter(s => s.value.startsWith(lower));
    },
    handler: async (args: string, ctx: any) => {
      rt.ctx = ctx;
      const trimmed = (args || "").trim();
      const spaceIdx = trimmed.indexOf(" ");
      const subcmd = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
      const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

      switch (subcmd) {
        case "import": {
          const { readFileSync, existsSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          const cwd = ctx?.cwd || process.cwd();
          let filePath = rest || "TODO.md";
          if (!existsSync(filePath)) filePath = resolve(cwd, filePath);
          if (!existsSync(filePath)) {
            ctx?.showStatus?.(`File not found: ${filePath}`);
            return;
          }
          const md = readFileSync(filePath, "utf-8");
          const { phases, errors } = markdownToPhases(md);
          if (errors.length > 0) {
            ctx?.showStatus?.(`Import errors: ${errors.join("; ")}`);
          }
          if (phases.length === 0) {
            ctx?.showStatus?.("No tasks found in file.");
            return;
          }
          rt.phases = phases;
          persist();
          refreshWidget();
          const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
          ctx?.showStatus?.(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${filePath}.`);
          return;
        }

        case "append": {
          if (!rest) { ctx?.showStatus?.("Usage: /todo append [<phase>] <task...>"); return; }
          const tokens = parseTokens(rest);
          // First token might be a phase name (fuzzy match), rest is the task
          const phases = rt.phases;
          const { phases: next, errors } = applyOp(phases, { op: "append", phase: tokens.length > 1 ? tokens[0] : "Tasks", items: [tokens.length > 1 ? tokens.slice(1).join(" ") : tokens[0]] });
          if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
          rt.phases = next;
          persist();
          refreshWidget();
          ctx?.showStatus?.(`Appended: ${tokens[tokens.length - 1]}`);
          return;
        }

        case "start": {
          if (!rest) { ctx?.showStatus?.("Usage: /todo start <task>"); return; }
          const found = findTaskFuzzy(rt.phases, rest);
          if (!found) { ctx?.showStatus?.(`Task not found: ${rest}`); return; }
          const { phases: next, errors } = applyOp(rt.phases, { op: "start", task: found.task.content });
          if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
          rt.phases = next;
          persist();
          refreshWidget();
          ctx?.showStatus?.(`Started: ${found.task.content}`);
          return;
        }

        case "done": {
          if (!rest) {
            // No args → mark all done
            const { phases: next, errors } = applyOp(rt.phases, { op: "done" });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.("All tasks completed.");
            return;
          }
          // Try task first, then phase
          const taskMatch = findTaskFuzzy(rt.phases, rest);
          if (taskMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "done", task: taskMatch.task.content });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Completed: ${taskMatch.task.content}`);
            return;
          }
          const phaseMatch = findPhaseFuzzy(rt.phases, rest);
          if (phaseMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "done", phase: phaseMatch.name });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Phase completed: ${phaseMatch.name}`);
            return;
          }
          ctx?.showStatus?.(`Task/phase not found: ${rest}`);
          return;
        }

        case "drop": {
          if (!rest) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "drop" });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.("All tasks abandoned.");
            return;
          }
          const taskMatch = findTaskFuzzy(rt.phases, rest);
          if (taskMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "drop", task: taskMatch.task.content });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Dropped: ${taskMatch.task.content}`);
            return;
          }
          const phaseMatch = findPhaseFuzzy(rt.phases, rest);
          if (phaseMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "drop", phase: phaseMatch.name });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Phase abandoned: ${phaseMatch.name}`);
            return;
          }
          ctx?.showStatus?.(`Task/phase not found: ${rest}`);
          return;
        }

        case "rm": {
          if (!rest) {
            rt.phases = [];
            persist();
            refreshWidget();
            ctx?.showStatus?.("Cleared all todos.");
            return;
          }
          const taskMatch = findTaskFuzzy(rt.phases, rest);
          if (taskMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "rm", task: taskMatch.task.content });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Removed: ${taskMatch.task.content}`);
            return;
          }
          const phaseMatch = findPhaseFuzzy(rt.phases, rest);
          if (phaseMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "rm", phase: phaseMatch.name });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Phase removed: ${phaseMatch.name}`);
            return;
          }
          ctx?.showStatus?.(`Task/phase not found: ${rest}`);
          return;
        }

        case "export": {
          const { writeFileSync, existsSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          const cwd = ctx?.cwd || process.cwd();
          const filePath = rest || "TODO.md";
          if (rt.phases.length === 0) { ctx?.showStatus?.("No todos to export."); return; }
          const md = phasesToMarkdown(rt.phases);
          try {
            writeFileSync(resolve(cwd, filePath), md, "utf-8");
            ctx?.showStatus?.(`Exported ${rt.phases.length} phase(s) to ${filePath}`);
          } catch (e: any) {
            ctx?.showStatus?.(`Export failed: ${e?.message || e}`);
          }
          return;
        }

        case "copy": {
          if (rt.phases.length === 0) { ctx?.showStatus?.("No todos."); return; }
          const md = phasesToMarkdown(rt.phases);
          ctx?.showStatus?.(md);
          return;
        }

        case "edit": {
          ctx?.showStatus?.("/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.");
          return;
        }
        case "toggle": {
          togglePanel();
          return;
        }
        default: {
          if (rt.phases.length === 0) { ctx?.showStatus?.("No todos. Use /todo append <task> to start one."); return; }
          const md = phasesToMarkdown(rt.phases);
          ctx?.showStatus?.(md, { wrap: true });
          return;
        }
      }
    },
  });
}
// ── Fuzzy helpers for /todo command ────────────────────────────

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  // Exact name (case-insensitive)
  const exact = phases.find((p) => p.name.toLowerCase() === q);
  if (exact) return exact;
  // Prefix match
  return phases.find((p) => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(q));
}

function findTaskFuzzy(phases: TodoPhase[], query: string): { task: TodoItem; phase: TodoPhase } | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  // Exact content (case-insensitive)
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content.toLowerCase() === q);
    if (task) return { task, phase };
  }
  // Substring match
  const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase().includes(q)) {
        matches.push({ task, phase });
      }
    }
  }
  return matches[0];
}

/** Parse quoted tokens from a command string (e.g. /todo append "My Phase" task) */
function parseTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === " " && !inQuote) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}
