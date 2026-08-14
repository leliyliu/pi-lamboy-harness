/**
 * Swarm Mode Extension for Pi
 *
 * Kimi Code-style in-process swarm with:
 * - `createAgentSession()` + `session.prompt()` for same-process subagents
 * - Grid layout with braille progress bars (adaptive columns)
 * - Status bar with segmented pip display
 * - model_tier routing via ctx.modelRegistry
 * - Two-step /cancel confirmation, resume via /resume
 * - ctx.ui.setWidget() for non-blocking display
 */

// ============================================================
// Entry Point — registers tools and commands
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ModelTier, SubAgentType, SwarmState, SubAgentTask } from "./packages/core/swarm/types";
import { setResumeResult } from "./packages/core/swarm/types";
import {
  FRAME_INTERVAL_MS,
  swarmState,
  setCurrentSwarm,
  setActiveSessions,
  setCancelPending,
  setCancelTimer,
  setSwarmCancelled,
  setSavedSwarmState,
  setGlobalAbortController,
  progressEstimator,
} from "./packages/core/swarm/types";
import { getDefaultModel, getDefaultProvider, runSubAgent, runProgressive, linkAbortSignal } from "./swarm/subagent";
import { SwarmWidgetComponent } from "./swarm/widget";
import { formatReport } from "./packages/core/swarm/report";
import { registerCommands } from "./swarm/commands";
import { goalManager } from "./packages/core/goal";
import type { PersistencePort } from "./packages/core/ports";
import { planManager } from "./packages/core/plan";
import { permissionManager, approvalViaRpcUi } from "./packages/core/permission";
import { registerPermissionCommands } from "./packages/core/permission/commands";
import { backgroundManager, registerBackgroundTools } from "./task";
import { cronManager, registerCronTools } from "./packages/core/task/cron";
import { registerAskUserQuestion, showQuestionDialog } from "./ask/index";
import { approvalTitleFor } from "./packages/core/ask/types";
import { shouldTruncate, truncationPathFor, buildTruncatedPreview, truncationThresholdFor } from "./packages/core/truncation/index";
import { registerTodoList, registerTodoReminders, bindTodoSession, clearTodoSession, restoreTodos, rt, persist, refreshWidget, togglePanel, syncTodoAutoClearTimer } from "./todo/index";
import { phasesToMarkdown, markdownToPhases, applyOp, TodoPhase, TodoItem } from "./packages/core/todo/types";
import { listDiscoverableSkillFiles } from "./packages/core/skills";
import { registerTui, setTuiBadgeProvider } from "./tui/index";
import { agentPauseGate } from "./packages/core/pause/gate";
import { registerPauseCommands } from "./pause/commands";
import { setBackgroundSessionDir } from "./task";
import shared from "./state";

// Session dir captured at session_start — transcript wire.jsonl 落盘根目录.
// Falls back to tmp when no sessionManager is available (RPC/print mode).
let mainSessionDir = path.join(os.tmpdir(), "pi-muselinn-harness");

// 0.29.0 feature imports
import { agentFileService, findProjectRoot } from "./packages/core/agent-file/index.ts";
import type { AgentProfile } from "./packages/core/agent-file/types.ts";
import { toolPolicyService } from "./packages/core/tool-policy/index.ts";
import { agentLifecycle } from "./packages/core/agent-lifecycle/index.ts";

// Interactive question tools (copied from Pi SDK examples)


// Shared: parse provider:model spec (also accepts provider/model slash form)
function parseModelSpec(spec: string): { provider?: string; modelId: string } {
  const colonIdx = spec.indexOf(":");
  if (colonIdx > 0) return { provider: spec.substring(0, colonIdx), modelId: spec.substring(colonIdx + 1) };
  const slashIdx = spec.indexOf("/");
  if (slashIdx > 0) return { provider: spec.substring(0, slashIdx), modelId: spec.substring(slashIdx + 1) };
  return { modelId: spec };
}

// Shared: bounded copy of swarm state for onUpdate details — per-task
// outputLines are replaced by a tail (last 5 lines) plus a total count so
// each progress push stays small. The final tool result keeps the full state.
function summarizeStateForUpdate(state: SwarmState): any {
  return {
    ...state,
    tasks: state.tasks.map((t) => {
      const lines = t.outputLines || [];
      return {
        ...t,
        outputLineCount: lines.length,
        outputLines: lines.length > 5
          ? [`[… ${lines.length - 5} earlier line(s) omitted]`, ...lines.slice(-5)]
          : lines,
      };
    }),
  };
}

// ============================================================
// Background swarm runner — fire-and-forget execution wired to the
// background task manager (task_list / task_output / task_stop).
// ============================================================
async function runSwarmInBackground(
  bgId: string,
  state: SwarmState,
  tasks: SubAgentTask[],
  ctx: any,
  maxC: number,
  outputPath?: string,
  agentProfile?: AgentProfile,
): Promise<void> {
  const controller = new AbortController();
  // task_stop flips the entry status to "aborted"; poll and translate that
  // into an abort so in-flight subagents and the worker pool wind down.
  const stopPoll = setInterval(() => {
    const t = backgroundManager.get(bgId);
    if (!t || t.status !== "running") {
      try { controller.abort(); } catch { /* ignore */ }
    }
  }, 500);
  try {
    await runProgressive(tasks, maxC, async (task) => {
      if (controller.signal.aborted) {
        task.status = "aborted";
        return;
      }
      await runSubAgent(task, ctx, controller.signal, () => {
        const d = tasks.filter((t) => t.status === "done").length;
        backgroundManager.appendOutput(bgId, [`progress: ${d}/${tasks.length} done`]);
      }, agentProfile);
    });

    // stop() already flipped the entry to "aborted" — leave it as-is.
    if (controller.signal.aborted) return;

    state.endTime = Date.now();
    state.status = tasks.every((t) => t.status === "done")
      ? "completed"
      : tasks.some((t) => t.status === "done")
        ? "partial"
        : "failed";

    const report = formatReport(state);
    if (outputPath) {
      // Kimi Code-style: full report lands in output_path; the task entry
      // keeps only a pointer + tail so in-memory outputLines stay small.
      try {
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(outputPath, report, "utf-8");
        backgroundManager.complete(bgId, [
          `[report written to ${outputPath} — use Read with offset/limit to page]`,
          ...report.split("\n").slice(-5),
        ]);
      } catch (e: any) {
        backgroundManager.complete(bgId, [`[failed to write output_path ${outputPath}: ${e?.message || e}]`, report]);
      }
    } else {
      backgroundManager.complete(bgId, report.split("\n"));
    }
  } catch (e: any) {
    backgroundManager.fail(bgId, e?.message || String(e));
  } finally {
    clearInterval(stopPoll);
    if (swarmState.currentSwarm === state) setCurrentSwarm(null);
    // Clear profile-level tool policy after background swarm completes
    try { toolPolicyService.clearProfilePolicy(); } catch { /* ok */ }
  }
}

const GOAL_ENTRY_TYPE = "muselinn_goal";

export default function (pi: ExtensionAPI) {
  // ── Main-session skills: expose Kimi Code-style skills directories
  //    (.kimi-code/skills, ~/.pi/skills — the dirs pi does NOT scan
  //    natively) via resources_discover. listDiscoverableSkillFiles
  //    returns individual SKILL.md files with names already provided by
  //    pi-native dirs filtered out, so no collision diagnostics. ──
  try {
    pi.on("resources_discover", async (event: { cwd: string }) => {
      try {
        const skillPaths = [...listDiscoverableSkillFiles(event.cwd || process.cwd())];
        return skillPaths.length > 0 ? { skillPaths } : undefined;
      } catch {
        return undefined;
      }
    });
  } catch { /* older pi without resources_discover — subagent path still works */ }

  // ── Goal persistence: save on every change ──
  // Note: pi/ctx go stale after session replacement (newSession/fork/reload
  // or process teardown in pi -p). Persistence callbacks may fire from
  // timers/background completions after that, so guard every appendEntry.
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
  // ask_user_question). Per-tool action titles (Kimi approval-panel
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

  // ── Background task manager binding ──
  backgroundManager.bind(
    (type, data) => { try { pi.appendEntry(type, data); } catch { /* stale ctx */ } },
    (msg, type) => { /* notifications handled via appendEntry */ },
  );

  // ── session_start: restore goal + plan from persisted entries + set status bar ──
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    // Set plan session directory (for plan file storage)
    try { planManager.setSessionDir(ctx.sessionManager.getSessionDir()); } catch { /* ok */ }
    // Capture session dir for subagent transcript 落盘 (swarm + background)
    try { mainSessionDir = ctx.sessionManager.getSessionDir(); setBackgroundSessionDir(mainSessionDir); } catch { /* fallback tmp */ }

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

    if (shared.swarmEnabled) {
      ctx.ui.setStatus("swarm-mode", ctx.ui.theme.fg("accent", "swarm"));
    }
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
    // Goal status bar (Kimi Code-style)
    const goalBadge = goalManager.buildFooterBadge();
    if (goalBadge) {
      const color = goalManager.getFooterBadgeColor();
      ctx.ui.setStatus("goal", ctx.ui.theme.fg(color, goalBadge));
    }
    // Running agents count (Kimi Code-style: [3 agents running])
    const agentCount = swarmState.activeSessions?.size ?? 0;
    ctx.ui.setStatus("agent-count", agentCount > 0
      ? ctx.ui.theme.fg("accent", `[${agentCount} agents running]`)
      : undefined
    );
    // Running background tasks count (Kimi Code-style: [2 tasks running])
    const runningTasks = backgroundManager.list().filter(t => t.status === "running").length;
    ctx.ui.setStatus("task-count", runningTasks > 0
      ? ctx.ui.theme.fg("accent", `[${runningTasks} tasks running]`)
      : undefined
    );

    // Agent lifecycle badge (Kimi Code-style: [3 agents running])
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

    // Restore background tasks from persisted entries. Pass the raw entry
    // list: restore() understands both the legacy full-array entry type and
    // the incremental per-task entry type (later entries win per task id).
    try {
      backgroundManager.restore(ctx.sessionManager.getEntries());
    } catch { /* not critical */ }

    // Restore cron tasks from persisted entries (cronManager scans for its own entry type)
    try {
      cronManager.restore(ctx.sessionManager.getEntries());
    } catch { /* not critical */ }

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

    // ── Agent File Catalog: discover custom agent files for this session ──
    try {
      const { profiles, errors } = agentFileService.discover(ctx.cwd);
      if (profiles.length > 0) {
        console.log(`[agent-file] Discovered ${profiles.length} agent profile(s)`);
      }
      if (errors.length > 0) {
        console.warn(`[agent-file] Discovery errors:`, errors);
      }
    } catch { /* non-critical */ }

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

    // Running agents count (Kimi Code-style)
    const agentCount = swarmState.activeSessions?.size ?? 0;
    ctx.ui.setStatus("agent-count", agentCount > 0
      ? ctx.ui.theme.fg("accent", `[${agentCount} agents running]`)
      : undefined
    );
    
    // Running background tasks count (Kimi Code-style)
    const runningTasks = backgroundManager.list().filter(t => t.status === "running").length;
    ctx.ui.setStatus("task-count", runningTasks > 0
      ? ctx.ui.theme.fg("accent", `[${runningTasks} tasks running]`)
      : undefined
    );

    // Agent lifecycle badge (Kimi Code-style)
    const lifecycleCount = agentLifecycle.getActiveCount();
    ctx.ui.setStatus("lifecycle-agent-count", lifecycleCount > 0
      ? ctx.ui.theme.fg("accent", `[${lifecycleCount} agents running]`)
      : undefined
    );
  }

  // ── Goal badge wall-clock: 1s tick while a goal is active ──
  // The badge shows live duration (Kimi Code footer parity); between turn
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
  // ── tool_result: spill oversized outputs to disk (Kimi toolResultTruncation)
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

    // Pause goal on user interrupt (Kimi Code-style). TurnEndEvent carries no
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
  registerAgentFileTools(pi);
  goalManager.registerCommands(pi);

  // ── Register plan tools and commands (from plan/ module) ──
  planManager.registerTools(pi);
  planManager.registerCommands(pi);

  // ── Register permission commands ──
  registerPermissionCommands(pi, permissionManager);

  // ── Register /todo slash command ──
  registerTodoCommand(pi);

  // ── tool_call: 18-level policy chain + plan mode restrictions ──
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
      // Kimi Code-aligned per-tool deny messages (plan-mode-guard-deny.ts parity).
      let reason: string;
      if (toolName === "task_stop") {
        reason = "TaskStop is not available in plan mode. Call exit_plan_mode to exit plan mode before stopping a background task.";
      } else if (toolName === "cron_create" || toolName === "cron_delete") {
        reason = `${toolName} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call exit_plan_mode first.`;
      } else {
        const planFilePath = planManager.getPlanFilePath();
        reason = `Plan mode is active. You may only write to the current plan file: ${planFilePath || "(no plan file selected yet)"}. Call exit_plan_mode to exit plan mode before editing other files.`;
      }
      ctx.ui.notify(reason, "warning");
      return { block: true, reason: `Plan Mode: ${reason}` };
    }

    // Kimi Code plan-mode-tool-approve parity: entering plan mode and
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
    
    // 18-level permission policy chain
    const result = await permissionManager.evaluate(toolName, input, ctx.cwd || process.cwd(), ctx);
    if (result?.block) {
      ctx.ui.notify(`Blocked: ${result.reason}`, "warning");
      return result;
    }
  });

  // ── Background Task Tools ──
  registerBackgroundTools(pi);

  // ── Cron Tools (scheduled prompts) ──
  registerCronTools(pi);

  // ============================================================
  // Shared: Task-aware model resolution
  // ============================================================
  async function resolveModelForTask(
    prompt: string,
    items: string[],
    available: any[],
    defaultModelId: string,
    defaultProvider: string,
    ctx: any
  ): Promise<string> {
    // Detect task type
    const hasImages = items.some((i: string) => /\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff)$/i.test(i));
    const needsVision = hasImages || /\b(vi(?:sual|deo|sion)|image|screen(?:shot|cap)|photo|multimod|[多视]模态|视觉|图像|截图|图片|照[片面]|视频|GIF|pixel|render|asset|sprite|texture|特效|光影|色彩|动画|UI.*check|界面.*检|[检审]查.*(?:视觉|画面|效果))\b/i.test(prompt);
    const isSimple = /\b(find|list|scan|grep|read|cat|ls|count|check|show|display)\b/.test(prompt);
    const isComplex = /\b(implement|refactor|design|optimize|create|build|write|debug|test|fix|architect|migrate|integrate)\b/.test(prompt);

    // Get the current session's active model (prefer it, as the user is already using it)
    const currentModelId = ctx.model?.id ?? "";
    const currentProvider = ctx.model?.provider ?? defaultProvider;

    // Score each available model
    const scored = available.map((m: any) => {
      let score = 0;
      const id = m.id.toLowerCase();
      const isMultimodal = m.input?.includes("image");
      const isFree = id.endsWith("-free");
      const isLargeContext = (m.contextWindow || 0) >= 100000;
      const costPerMee = (m.cost?.input || 0) + (m.cost?.output || 0);

      if (m.provider === defaultProvider) score += 100;

      // Prefer the same provider as the current session
      if (currentProvider && m.provider === currentProvider) score += 80;

      // Prefer the current session's active model (user is already using it)
      if (currentModelId && m.id === currentModelId) score += 200;

      // Cost-aware: penalize expensive models unless task really needs them
      // Free models get a big boost; expensive ones need strong justification
      if (isFree) score += 50;
      else if (costPerMee > 10) score -= 60;  // >$10/M tokens
      else if (costPerMee > 5) score -= 30;   // >$5/M tokens
      else if (costPerMee > 2) score -= 10;   // >$2/M tokens

      // Multimodal routing: only prefer multimodal when task needs vision
      if (needsVision) {
        if (isMultimodal) score += 200;  // Strong preference for multimodal
        else score -= 150;               // Penalize text-only for vision tasks
      } else if (hasImages) {
        if (isMultimodal) score += 200;
        else score -= 100;
      } else if (isSimple) {
        if (isFree) score += 150;
        score += 50;
      } else if (isComplex) {
        if (isLargeContext) score += 100;
        if (!isFree) score += 50;
      } else {
        if (isFree) score += 50;
      }

      if (isFree) score += 30;
      score -= id.length;
      return { model: m, score };
    }).sort((a: any, b: any) => b.score - a.score);

    if (scored.length >= 2 && Math.abs(scored[0].score - scored[1].score) < 20) {
      // Show top candidates as structured selection list
      const modelOptions = scored.slice(0, 5).map((s: any) => {
        const m = s.model;
        const free = m.id.endsWith("-free") ? " (free)" : "";
        const vision = m.input?.includes("image") ? " [multimodal]" : "";
        const context = m.contextWindow ? ` ${Math.round(m.contextWindow/1000)}k ctx` : "";
        return `${m.id}${free}${vision}${context} [${m.provider}]`;
      });
      modelOptions.push("Other (type a model name)");

      const choice = await ctx.ui.select(
        `Which model? (default: ${scored[0].model.id})`,
        modelOptions,
        { timeout: 30000 }
      );

      if (choice === "Other (type a model name)") {
        const custom = await ctx.ui.input("Enter model name:", scored[0].model.id, { timeout: 30000 });
        if (custom?.trim()) {
          const exact = scored.find((s: any) => s.model.id === custom.trim());
          if (exact) return `${exact.model.provider}:${exact.model.id}`;
          const partial = available.find((m: any) => m.id.includes(custom.trim()));
          if (partial) return `${partial.provider}:${partial.id}`;
          return custom.trim();
        }
      } else if (choice) {
        const idx = modelOptions.indexOf(choice);
        if (idx >= 0 && idx < scored.length) return `${scored[idx].model.provider}:${scored[idx].model.id}`;
      }
      return `${scored[0].model.provider}:${scored[0].model.id}`;
    } else if (scored.length > 0) {
      return `${scored[0].model.provider}:${scored[0].model.id}`;
    } else {
      const fromDefaultProvider = available.find((m: any) => m.id === defaultModelId && m.provider === defaultProvider);
      const fromAny = available.find((m: any) => m.id === defaultModelId);
      return (fromDefaultProvider || fromAny || available[0])?.id || "";
    }
  }

  // ============================================================
  // agent_swarm - Batch parallel with template
  // ============================================================
  pi.registerTool({
    name: "agent_swarm",
    label: "Agent Swarm",
    description:
      "Batch parallel: same template applied to multiple items. Each item gets isolated sub-agent.",
    promptSnippet: "agent_swarm — auto-routes models based on task type unless specified",
    promptGuidelines: [
      "Model routing is automatic: if you don't specify 'model', the system picks the best model based on task type, current session model, and available capabilities.",
      "If the user mentions specific models (e.g., 'use deepseek' or '用mimo'), pass them through the 'model' or 'model_map' parameter.",
      "For multi-model swarms, use model_map to assign different models per item (e.g., \"0\": \"opencode-go:deepseek-v4-flash\", \"1\": \"xiaomi:mimo-v2.5\").",
      "When uncertain which model is best, call ask_user_question to let the user choose — then pass their response as model/model_map.",
      "For image/multimodal tasks, the system automatically prefers multimodal-capable models.",
      "Use agent_file to apply a custom agent profile (from agent_file_list) — it overrides the system prompt and applies tool/subagent restrictions.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Swarm name for display" }),
      subagent_type: StringEnum(["explore", "plan", "coder"] as const, {
        default: "coder",
      }),
      prompt_template: Type.Optional(Type.String({
        description: "Template with {{item}} placeholder. Required when items is provided.",
      })),
      items: Type.Optional(Type.Array(Type.String(), {
        description: "Items to process. Each item launches one new sub-agent. Max 128.",
      })),
      resume_agent_ids: Type.Optional(
        Type.Record(
          Type.String({ description: "Existing subagent agent_id" }),
          Type.String({ description: "Prompt to resume that subagent" }),
          { description: "Map of existing subagent agent_id to prompt for resuming. Resumed before new item-based spawns." },
        ),
      ),
      model_tier: Type.Optional(
        StringEnum(["cheap", "balanced", "premium", "auto"] as const, {
          default: "auto",
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Override model for all agents" }),
      ),
      model_map: Type.Optional(
        Type.Record(
          Type.String({ description: "Item index (0-based)" }),
          Type.String({ description: "Model name or alias for this item" }),
          { description: "Per-item model overrides. Keys are item indices, values are model names/aliases." },
        ),
      ),
      max_concurrency: Type.Optional(Type.Number({ default: 5 })),
      run_in_background: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "Run the swarm as a background task and return a task ID immediately. Results are collected via task_list/task_output; final report optionally lands in output_path.",
        }),
      ),
      output_path: Type.Optional(
        Type.String({
          description: "Only with run_in_background: write the final swarm report to this file (page through it with Read offset/limit).",
        }),
      ),
      agent_file: Type.Optional(Type.String({
        description: "Name of a custom agent profile (from agent_file_list) to use for all agents in the swarm. Overrides system prompt and applies tool/subagent restrictions.",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!shared.swarmEnabled) {
        return {
          content: [{ type: "text", text: "Swarm mode is OFF. Use /swarm on to enable." }],
          details: null,
        };
      }

      const tier: ModelTier = params.model_tier || "auto";
      const maxC = Math.min(params.max_concurrency || 5, 128);
      const runInBackground = params.run_in_background === true;
      const defaultModelId = getDefaultModel();
      const defaultProvider = getDefaultProvider();

      // ── Runtime model selection ───────────────────────────────────────────
      const available = ctx.modelRegistry?.getAvailable() || [];

      // Model alias map: convenience name → actual model ID
      // These are the REAL model IDs from the registry
      // Smart model resolution (fully automatic - no hardcoded aliases)
      let modelId = params.model || "";
      if (modelId) {
        // User specified: support provider:model / provider/model, then fuzzy match
        const parsed = parseModelSpec(modelId);
        let candidates: any[];
        const parsedProvider = parsed.provider;
        if (parsedProvider) {
          candidates = available.filter((m: any) =>
            m.id.toLowerCase() === parsed.modelId.toLowerCase() &&
            m.provider?.toLowerCase() === parsedProvider.toLowerCase()
          );
          if (candidates.length === 0) {
            candidates = available.filter((m: any) =>
              m.id.toLowerCase() === parsed.modelId.toLowerCase()
            );
          }
        } else {
          const query = modelId.toLowerCase();
          candidates = available.filter((m: any) => {
            const id = m.id.toLowerCase();
            const name = (m.name || "").toLowerCase();
            const provider = (m.provider || "").toLowerCase();
            return id.includes(query) || name.includes(query) || provider.includes(query);
          });
        }
        if (candidates.length === 0) {
          // Never return undefined — pi reads result.content and crashes.
          return { content: [{ type: "text", text: `No model matching "${modelId}" found. Available: ${available.map((m: any) => m.id).slice(0, 10).join(", ")}...` }], details: undefined };
        }
        const scored = candidates.map((m: any) => {
          let score = 0;
          if (m.provider === defaultProvider) score += 100;
          if (m.id.endsWith("-free")) score += 50;
          score -= m.id.length;
          return { model: m, score };
        }).sort((a: any, b: any) => b.score - a.score);
        modelId = scored[0].model.id;
      } else {
        // Auto-select based on task type
        modelId = await resolveModelForTask(
          (params.prompt_template || "").toLowerCase(),
          params.items || [],
          available, defaultModelId, defaultProvider, ctx
        );
      }
      if (!modelId) {
        return { content: [{ type: "text", text: "No models available in registry." }], details: undefined };
      }
      const selectedModelObj = available.find((m: any) => m.id === modelId);
      const isVision = selectedModelObj?.input?.includes("image");
      if (isVision) {
        console.log(`[swarm] Selected multimodal model: ${modelId} (supports text+image)`);
      }

      // Resolve model_map (auto-discover best matching model)
      const rawMap = params.model_map || {};
      const resolvedMap: Record<string, string> = {};
      function autoResolveModel(query: string): string {
        const q = query.toLowerCase();
        const candidates = available.filter((m: any) => {
          const id = m.id.toLowerCase();
          const name = (m.name || "").toLowerCase();
          return id.includes(q) || name.includes(q);
        });
        if (candidates.length === 0) return query; // fallback to as-is
        const scored = candidates.map((m: any) => {
          let s = 0;
          if (m.provider === defaultProvider) s += 100;
          if (m.id.endsWith("-free")) s += 50;
          s -= m.id.length;
          return { model: m, score: s };
        }).sort((a: any, b: any) => b.score - a.score);
        return scored[0].model.id;
      }
      for (const [k, v] of Object.entries(rawMap)) {
        resolvedMap[k] = autoResolveModel(v as string);
      }

      // Helper: resolve provider:model spec to actual model ID
      function resolveModelSpec(spec: string): string {
        const parsed = parseModelSpec(spec);
        const mId = parsed.modelId;
        const prov = parsed.provider;
        if (prov) {
          // Find model on specific provider
          const found = available.find((m: any) => m.id === mId && m.provider === prov);
          if (found) return `${found.provider}:${found.id}`;
          // If not found on specified provider, try any provider
          const anyProv = available.find((m: any) => m.id === mId);
          return anyProv ? `${anyProv.provider}:${anyProv.id}` : mId;
        }
        // No provider specified: prefer default provider, then any
        const fromDefault = available.find((m: any) => m.id === mId && m.provider === defaultProvider);
        const fromAny = available.find((m: any) => m.id === mId);
        const found = fromDefault || fromAny;
        return found ? `${found.provider}:${found.id}` : mId;
      }

            // ── Build tasks ──────────────────────────────────────────────────────
      const tasks: SubAgentTask[] = [];

      // Kimi Code-style: resumed subagents first, then item-based spawns
      const resumeIds = (params.resume_agent_ids || {}) as Record<string, string>;
      let taskId = 0;

      for (const [agentId, prompt] of Object.entries(resumeIds)) {
        taskId++;
        const rawModel = resolvedMap[String(taskId)] || modelId;
        const resolvedModel = resolveModelSpec(rawModel);
        tasks.push({
          id: agentId,
          agent: params.subagent_type || 'coder',
          type: params.subagent_type as SubAgentType,
          task: prompt,
          model: resolvedModel,
          status: "pending" as const,
          turns: 0,
          usage: { input: 0, output: 0, cost: 0 },
          outputLines: [],
          progressPercent: 0,
          toolCalls: 0,
          estimatedTotalCalls: 10,
          ticks: 0,
        });
      }

      for (const [i, item] of (params.items || []).entries()) {
        taskId++;
        const rawModel = resolvedMap[String(i)] || resolvedMap[String(i + 1)] || modelId;
        const resolvedModel = resolveModelSpec(rawModel);
        const promptTemplate = params.prompt_template || '';
        tasks.push({
          id: String(taskId).padStart(3, "0"),
          agent: params.subagent_type || 'coder',
          type: params.subagent_type as SubAgentType,
          task: promptTemplate.replace(/\{\{item\}\}/g, item),
          promptTemplate,
          item,
          model: resolvedModel,
          status: "pending" as const,
          turns: 0,
          usage: { input: 0, output: 0, cost: 0 },
          outputLines: [],
          progressPercent: 0,
          toolCalls: 0,
          estimatedTotalCalls: 10,
          ticks: 0,
        });
      }

      // ── Agent profile resolution ──
      let agentProfile: AgentProfile | undefined;
      const agentFileName = params.agent_file as string | undefined;
      if (agentFileName) {
        agentProfile = agentFileService.getProfile(agentFileName);
        if (!agentProfile) {
          return { content: [{ type: "text", text: `Agent profile "${agentFileName}" not found. Use agent_file_list to see available profiles.` }], details: undefined };
        }
        // Apply tool gating from agent profile to all tasks
        if (agentProfile.tools || agentProfile.disallowedTools) {
          toolPolicyService.setProfilePolicy({
            tools: agentProfile.tools,
            disallowedTools: agentProfile.disallowedTools,
          });
        }
      }

      // Init swarm state ------------------------------------------------------
      const state: SwarmState = {
        name: params.description,
        mode: "swarm",
        modelTier: tier,
        tasks,
        status: "pending",
        startTime: Date.now(),
      };
      setCurrentSwarm(state);
      progressEstimator.reset();
      for (const t of tasks) progressEstimator.ensureMember(t.id);
      setActiveSessions(new Map());
      setCancelPending(false);
      setSwarmCancelled(false);
      if (swarmState.cancelTimer) {
        clearTimeout(swarmState.cancelTimer);
        setCancelTimer(null);
      }

      // ── Background mode: hand off to the background task manager ──
      if (runInBackground) {
        const bgId = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        backgroundManager.register({
          id: bgId,
          prompt: `[swarm] ${params.description} (${tasks.length} agents)`,
          model: modelId,
          subagentType: params.subagent_type || "coder",
          status: "running",
          outputLines: [],
          startTime: Date.now(),
          createdAt: Date.now(),
          turns: 0,
          usage: { input: 0, output: 0, cost: 0 },
        });
        const outputPath = params.output_path as string | undefined;
        state.status = "running";
        // Fire-and-forget: progress lands in the task entry, the final
        // report in the entry (and optionally in output_path).
        void runSwarmInBackground(bgId, state, tasks, ctx, maxC, outputPath, agentProfile);
        return {
          content: [{
            type: "text",
            text:
              `Swarm started in background. Task ID: ${bgId}\n` +
              `${tasks.length} agents queued (max_concurrency=${maxC}, 30min/agent timeout).\n` +
              `Use task_list to check status, task_output(task_id="${bgId}", block=true) to wait for completion.` +
              (outputPath ? `\nFinal report will be written to: ${outputPath}` : ""),
          }],
          details: null,
        };
      }

      // Setup parent abort controller for cancel propagation
      setGlobalAbortController(new AbortController());
      const unlinkGlobal = signal
        ? linkAbortSignal(signal, swarmState.globalAbortController!)
        : () => {};

      const theme = ctx.ui.theme;
      state.status = "running";

      // Widget setup ----------------------------------------------------------
      // pi-tui Component (same Container-based protocol as the /tasks
      // browser). pi mounts it via setWidget and calls render(width) with the
      // real viewport width; all line building is fingerprint-gated inside
      // widget.update().
      const widget = new SwarmWidgetComponent(() => swarmState.currentSwarm, theme, () => swarmState.cancelPending);
      let widgetTui: any = null;
      ctx.ui.setWidget("swarm-mode-progress", (t: any, _th: any) => {
        widgetTui = t;
        return widget;
      });
      const repaintWidget = () => {
        widgetTui?.invalidate?.();
        widgetTui?.requestRender?.();
      };
      const updateWidget = () => {
        if (widget.update() === "changed") repaintWidget();
      };
      updateWidget();

      // Periodic refresh at FRAME_INTERVAL_MS (250ms) — drives the braille
      // fill animation and status-line spinner. The fingerprint gate inside
      // widget.update() skips the rebuild + repaint on frames where nothing
      // visible changed, and the timer stops itself once the build reports
      // refreshIntervalMs === 0 (animation settled).
      let refreshTimer: ReturnType<typeof setInterval> | null = null;
      const startRefresh = () => {
        if (refreshTimer) return;
        refreshTimer = setInterval(() => {
          const status = widget.update();
          if (status === "changed") repaintWidget();
          // Stop when the swarm is gone or the animation has settled.
          if ((status === "empty" || widget.refreshIntervalMs <= 0) && refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
          }
        }, FRAME_INTERVAL_MS);
      };
      startRefresh();

      // Progress callback -----------------------------------------------------
      // details is a truncated summary (per-task outputLines capped to a tail)
      // so per-frame updates pushed to the parent agent stay small; the final
      // tool result below still returns the full state.
      const updateProgress = () => {
        updateWidget();
        const d = tasks.filter((t) => t.status === "done").length;
        onUpdate?.({
          content: [
            { type: "text", text: `${state.name}: ${d}/${tasks.length} done` },
          ],
          details: summarizeStateForUpdate(state),
        });
      };

      // Kimi Code-style: progressive launch (initial batch + 700ms spacing),
      // bounded by max_concurrency via the worker pool in runProgressive.
      try {
        await runProgressive(tasks, maxC, async (task) => {
          if (signal?.aborted || swarmState.currentSwarm === null) {
            task.status = "aborted";
            return;
          }
          // Combined signal: tool-level abort OR global /cancel
          const combinedSignal = AbortSignal.any?.(
            [signal, swarmState.globalAbortController?.signal].filter(Boolean) as AbortSignal[],
          ) ?? signal;
          await runSubAgent(task, { ...ctx, sessionDir: mainSessionDir }, combinedSignal, updateProgress, agentProfile);
        }, { initialBatch: Math.min(5, maxC), spacingMs: 700 });
      } finally {
        // Clean up global abort controller
        unlinkGlobal();
        setGlobalAbortController(null);
        state.endTime = Date.now();
        state.status = tasks.every((t) => t.status === "done")
          ? "completed"
          : tasks.some((t) => t.status === "done")
            ? "partial"
            : "failed";

        // Final one-shot repaint (fingerprint-gated like everything else);
        // after this the timer is stopped and nothing re-renders the widget.
        if (widget.update() === "changed") repaintWidget();

        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        setActiveSessions(null);

        // Save for resume if interrupted
        if (state.status === "partial" || state.status === "failed") {
          const completedItems = tasks
            .filter((t) => t.status === "done")
            .map((t) => t.item || t.task);
          setSavedSwarmState({
            name: state.name,
            items: params.items ?? [],
            modelTier: tier,
            subagentType: params.subagent_type as SubAgentType,
            promptTemplate: params.prompt_template ?? "",
            maxConcurrency: maxC,
            completedItems,
          });
        }

        setTimeout(() => {
          // The session may have ended/been replaced before this deferred
          // cleanup fires (e.g. pi -p exits right after the report). Any
          // access to a stale ctx throws — the widget is gone with the old
          // session anyway, so just bail out.
          try {
            ctx.ui.setWidget("swarm-mode-progress", undefined);
          } catch { /* stale ctx */ }
          if (swarmState.currentSwarm === state) setCurrentSwarm(null);
        }, 30000);

        // Clear profile-level tool policy after swarm completes
        try { toolPolicyService.clearProfilePolicy(); } catch { /* ok */ }
      }

      return {
        content: [{ type: "text", text: formatReport(state) }],
        details: state,
      };
    },

    renderCall(args, theme) {
      let text = `${theme.fg("toolTitle", theme.bold("swarm "))}`;
      text += `${theme.fg("accent", args.description)}`;
      text += ` ${theme.fg("muted", `${args.subagent_type} × ${args.items?.length ?? 0}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _r, theme) {
      const state = result.details as any;
      if (!state || !state.tasks) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text.slice(0, 100) : "(no output)", 0, 0);
      }

      const total = state.tasks.length;
      const done = state.tasks.filter((t: any) => t.status === "done").length;
      const failed = state.tasks.filter((t: any) => t.status === "failed").length;
      const aborted = state.tasks.filter((t: any) => t.status === "aborted").length;

      let icon: string;
      if (failed > 0) icon = theme.fg("error", "\u2717");
      else if (aborted > 0) icon = theme.fg("warning", "\u26A0");
      else icon = theme.fg("success", "\u2713");

      const label = failed > 0 ? `${done}/${total} completed, ${failed} failed` : aborted > 0 ? `${done}/${total} completed, ${aborted} aborted` : `${done}/${total} completed`;
      return new Text(
        `${icon} ${theme.fg("text", "Agent swarm:")} ${theme.fg(failed > 0 ? "error" : "success", label)}`,
        0,
        0,
      );
    },
  });

  // ============================================================
  // agent - Single dispatch
  // ============================================================
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Single agent dispatch: isolated sub-agent for a specific task.",
    promptSnippet: "agent — single sub-agent with auto model routing",
    promptGuidelines: [
      "Model routing is automatic: if you don't specify 'model', the system picks the best model based on task type, current session model, and available capabilities.",
      "If the user mentions a specific model name, pass it via the 'model' parameter.",
      "When uncertain which model to use, call ask_user_question to let the user choose.",
      "Use agent_file to apply a custom agent profile (from agent_file_list) — it overrides the system prompt and applies tool/subagent restrictions.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Task prompt" }),
      description: Type.String({ description: "Short description" }),
      subagent_type: StringEnum(["explore", "plan", "coder"] as const, {
        default: "coder",
      }),
      model_tier: Type.Optional(
        StringEnum(["cheap", "balanced", "premium", "auto"] as const, {
          default: "auto",
        }),
      ),
      model: Type.Optional(Type.String()),
      agent_file: Type.Optional(Type.String({
        description: "Name of a custom agent profile (from agent_file_list) to use for this sub-agent. Overrides system prompt and applies tool/subagent restrictions.",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tier: ModelTier = params.model_tier || "auto";
      if (!shared.swarmEnabled) {
        return {
          content: [
            {
              type: "text",
              text: "Swarm mode is OFF. Use /swarm on to enable.",
            },
          ],
          details: null,
        };
      }

      const defaultModelId = getDefaultModel();
      const defaultProvider = getDefaultProvider();
      const available = ctx.modelRegistry?.getAvailable() || [];


      // Smart model resolution (fully automatic - same as agent_swarm)
      let modelId = params.model || "";
      if (modelId) {
        // Parse provider:model format first
        const parsed = parseModelSpec(modelId);
        let candidates: any[];
        const parsedProvider = parsed.provider;
        if (parsedProvider) {
          // Exact provider + model ID match
          candidates = available.filter((m: any) =>
            m.id.toLowerCase() === parsed.modelId.toLowerCase() &&
            m.provider?.toLowerCase() === parsedProvider.toLowerCase()
          );
          // Fallback: any provider with this model ID
          if (candidates.length === 0) {
            candidates = available.filter((m: any) =>
              m.id.toLowerCase() === parsed.modelId.toLowerCase()
            );
          }
        } else {
          // No provider specified: text search across id/name/provider
          const query = modelId.toLowerCase();
          candidates = available.filter((m: any) => {
            const id = m.id.toLowerCase();
            const name = (m.name || "").toLowerCase();
            const provider = (m.provider || "").toLowerCase();
            return id.includes(query) || name.includes(query) || provider.includes(query);
          });
        }
        if (candidates.length === 0) {
          // Never return undefined — pi reads result.content and crashes.
          return { content: [{ type: "text", text: `No model matching "${modelId}" found.` }], details: undefined };
        }
        const scored = candidates.map((m: any) => {
          let score = 0;
          if (m.provider === defaultProvider) score += 100;
          if (m.id.endsWith("-free")) score += 50;
          score -= m.id.length;
          return { model: m, score };
        }).sort((a: any, b: any) => b.score - a.score);
        modelId = `${scored[0].model.provider}:${scored[0].model.id}`;
      } else {
        // Auto-select based on task type
        modelId = await resolveModelForTask(
          (params.prompt || "").toLowerCase(),
          [], // agent tool has no items
          available, defaultModelId, defaultProvider, ctx
        );
      }
      if (!modelId) {
        return { content: [{ type: "text", text: "No models available." }], details: undefined };
      }

      // ── Agent profile resolution ──
      let agentProfile: AgentProfile | undefined;
      const agentFileName = params.agent_file as string | undefined;
      if (agentFileName) {
        agentProfile = agentFileService.getProfile(agentFileName);
        if (!agentProfile) {
          return { content: [{ type: "text", text: `Agent profile "${agentFileName}" not found. Use agent_file_list to see available profiles.` }], details: undefined };
        }
        // Apply tool gating from agent profile
        if (agentProfile.tools || agentProfile.disallowedTools) {
          toolPolicyService.setProfilePolicy({
            tools: agentProfile.tools,
            disallowedTools: agentProfile.disallowedTools,
          });
        }
      }

      // No more scoring code below this point

      const task: SubAgentTask = {
        id: "001",
        agent: params.subagent_type,
        type: params.subagent_type as SubAgentType,
        task: params.prompt,
        prompt: params.prompt,
        model: modelId,
        status: "pending" as const,
        turns: 0,
        usage: { input: 0, output: 0, cost: 0 },
        outputLines: [],
        progressPercent: 0,
        toolCalls: 0,
        estimatedTotalCalls: 10,
        ticks: 0,
      };

      const state: SwarmState = {
        name: params.description,
        mode: "agent",
        modelTier: tier,
        tasks: [task],
        status: "pending",
        startTime: Date.now(),
      };
      setCurrentSwarm(state);
      progressEstimator.reset();
      progressEstimator.ensureMember("001");
      setActiveSessions(new Map());
      setSwarmCancelled(false);

      const theme = ctx.ui.theme;
      state.status = "running";

      // pi-tui Component (same protocol as agent_swarm's widget above).
      const widget = new SwarmWidgetComponent(() => state, theme, () => false);
      let widgetTui: any = null;
      ctx.ui.setWidget("swarm-mode-progress", (t: any, _th: any) => {
        widgetTui = t;
        return widget;
      });
      const repaintWidget = () => {
        widgetTui?.invalidate?.();
        widgetTui?.requestRender?.();
      };
      const updateWidget = () => {
        if (widget.update() === "changed") repaintWidget();
      };
      updateWidget();

      // Periodic refresh at FRAME_INTERVAL_MS (250ms) — same fingerprint
      // gate and settle-stop logic as agent_swarm.
      let refreshTimer: ReturnType<typeof setInterval> | null = null;
      const startRefresh = () => {
        if (refreshTimer) return;
        refreshTimer = setInterval(() => {
          const status = widget.update();
          if (status === "changed") repaintWidget();
          if ((status === "empty" || widget.refreshIntervalMs <= 0) && refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
          }
        }, FRAME_INTERVAL_MS);
      };
      startRefresh();

      const update = () => updateWidget();

      try {
        await runSubAgent(task, { ...ctx, sessionDir: mainSessionDir }, signal ?? new AbortController().signal, update, agentProfile);
      } finally {
        // Clean up refresh timer
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        state.endTime = Date.now();
        state.status = task.status === "done" ? "completed" : "failed";

        // Final one-shot repaint; nothing re-renders the widget afterwards.
        if (widget.update() === "changed") repaintWidget();

        setActiveSessions(null);

        setTimeout(() => {
          // Same stale-ctx guard as agent_swarm: the session may be gone by
          // the time this deferred cleanup fires.
          try {
            ctx.ui.setWidget("swarm-mode-progress", undefined);
          } catch { /* stale ctx */ }
          if (swarmState.currentSwarm === state) setCurrentSwarm(null);
        }, 30000);
      }

      return {
        content: [{ type: "text", text: formatReport(state) }],
        details: state,
      };
    },

    renderCall(args, theme) {
      let text = `${theme.fg("toolTitle", theme.bold("agent "))}`;
      text += `${theme.fg("accent", args.description)}`;
      text += ` ${theme.fg("muted", args.subagent_type)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _r, theme) {
      const state = result.details as any;
      if (!state || !state.tasks || state.tasks.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text.slice(0, 100) : "(no output)", 0, 0);
      }

      const task = state.tasks[0];
      const icon = task.status === "done" ? theme.fg("success", "\u2713") :
                   task.status === "failed" ? theme.fg("error", "\u2717") :
                   task.status === "aborted" ? theme.fg("warning", "\u26A0") : theme.fg("muted", "○");
      const label = task.status === "done" ? "Completed" :
                    task.status === "failed" ? `Failed: ${(task.error || "").slice(0, 40)}` :
                    task.status === "aborted" ? "Aborted" : "Running...";
      return new Text(
        `${icon} ${theme.fg("text", "Agent:")} ${theme.fg(task.status === "done" ? "success" : "error", label)}`,
        0,
        0,
      );
    },
  });

  // ============================================================
  // Commands
  // ============================================================
  registerCommands(pi);
  // ── Pause / steer commands (freeze + runtime message injection) ──
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

// ============================================================
// Agent File Tools
// ============================================================
function registerAgentFileTools(pi: ExtensionAPI): void {
  // ── agent_file_list: list discovered agent profiles ──
  pi.registerTool({
    name: "agent_file_list",
    label: "Agent File List",
    description: "List all discovered custom agent profiles from agent files (.md).",
    promptSnippet: "agent_file_list — list available custom agent profiles",
    promptGuidelines: [
      "Use agent_file_list to see what custom agent profiles are available in the project.",
      "Profiles are loaded from .pi/agents/, .kimi-code/agents/, and .agents/agents/ directories.",
      "Each profile has a name, description, and optional tool/subagent restrictions.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const profiles = agentFileService.getAllProfiles();
      if (profiles.length === 0) {
        return { content: [{ type: "text", text: "No custom agent profiles found." }], details: undefined };
      }
      const lines = profiles.map((p) => {
        const tools = p.tools ? ` tools=[${p.tools.join(",")}]` : "";
        const disallowed = p.disallowedTools ? ` disallowed=[${p.disallowedTools.join(",")}]` : "";
        const subagents = p.subagents ? ` subagents=[${p.subagents.join(",")}]` : "";
        return `  ${p.name} — ${p.description}${tools}${disallowed}${subagents} (${p.source})`;
      });
      return { content: [{ type: "text", text: `Agent profiles:\n${lines.join("\n")}` }], details: undefined };
    },
  });

  // ── agent_file_info: inspect a specific agent profile ──
  pi.registerTool({
    name: "agent_file_info",
    label: "Agent File Info",
    description: "Show full details of a specific agent profile.",
    promptSnippet: "agent_file_info — details of a specific agent profile",
    parameters: Type.Object({
      name: Type.String({ description: "Agent profile name (from agent_file_list)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const profile = agentFileService.getProfile(params.name as string);
      if (!profile) {
        return { content: [{ type: "text", text: `Agent profile "${params.name}" not found.` }], details: undefined };
      }
      const tools = profile.tools ? `\n  Allowed tools: ${profile.tools.join(", ")}` : "";
      const disallowed = profile.disallowedTools ? `\n  Disallowed tools: ${profile.disallowedTools.join(", ")}` : "";
      const subagents = profile.subagents ? `\n  Subagent types: ${profile.subagents.join(", ")}` : "";
      const src = profile.sourcePath ? `\n  Source: ${profile.sourcePath}` : "";
      return {
        content: [{
          type: "text",
          text: [
            `Agent: ${profile.name}`,
            `Description: ${profile.description}`,
            `Scope: ${profile.source}`,
            tools,
            disallowed,
            subagents,
            src,
            `\nSystem prompt:\n${"─".repeat(40)}\n${profile.systemPrompt.slice(0, 1000)}`,
          ].join(""),
        }],
        details: undefined,
      };
    },
  });
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
