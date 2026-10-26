// ============================================================
// Extension entry: Goal — create/get/update/set_goal_budget tools,
// /goal command, persistence (appendEntry + monotonic restore),
// budget detection on turn_end, overflow/429 recovery, compaction
// preservation, context injection, and the live footer badge.
//
// Filter out this file to drop goal lifecycle management.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { goalManager } from "../packages/core/goal/index.ts";
import { GOAL_ENTRY_TYPE, GOAL_LIMITED_ALLOWED_TOOLS_LABEL } from "../packages/core/goal/types.ts";
import type { PersistencePort } from "../packages/core/ports";

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

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Refresh model catalog once at startup (Pi 0.80.8 async refresh).
    // Fire-and-forget: this handler runs inside init()'s awaited session_start
    // emit, so awaiting a network refresh here blocks the TUI input loop when
    // the catalog fetch stalls (no signal/timeout). Pi's own run() already
    // refreshes in the background after init(), so startup never needs to
    // wait on the network. (Host-level nicety; lives here because Goal is
    // the thickest always-on module.)
    void ctx.modelRegistry?.refresh?.().catch(() => {});

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

    // Goal status bar (reflects restored state)
    const goalBadge = goalManager.buildFooterBadge();
    if (goalBadge) {
      const color = goalManager.getFooterBadgeColor();
      ctx.ui.setStatus("goal", ctx.ui.theme.fg(color, goalBadge));
    }
  });

  // ── session_before_compact: preserve goal across compaction (@narumitw style) ──
  pi.on("session_before_compact", (_event, _ctx) => {
    const goal = goalManager.getGoal();
    if (goal && goal.status === "active") {
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

  // Inject goal context into the system prompt
  pi.on("context", (event, _ctx) => {
    goalManager.injectIntoMessages(event.messages);
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

  // ── tool_call: B2 hard gate (spec §3) ──
  // shouldBlockTool was defined but never wired — the "no tools after budget
  // exhaustion" contract was prompt-only. Now enforced mechanically, same
  // pattern as 20-plan.ts:58-66 ({ block: true, reason }). Whitelist
  // (get_goal/update_goal/handoff) matches the wrap-up injection (B1): the
  // exhausted turn must still be able to park the handoff briefing.
  // env PI_LAMBOY_GOAL_TOOL_GATE=0 disables (default on).
  if (process.env.PI_LAMBOY_GOAL_TOOL_GATE !== "0") {
    pi.on("tool_call", async (event, ctx) => {
      const toolName = (event as { toolName?: string }).toolName ?? "";
      if (goalManager.shouldBlockTool(toolName)) {
        // Nit 5 (review): reason string shares the single-source whitelist label
        // from types.ts (GOAL_LIMITED_ALLOWED_TOOLS_LABEL) — no drift with the
        // wrap-up injection or shouldBlockTool.
        const reason =
          `Goal ${goalManager.getGoal()?.status}: only ${GOAL_LIMITED_ALLOWED_TOOLS_LABEL} allowed. ` +
          `Write the handoff briefing (context, decisions, files, next task) so the user can continue via /handoff.`;
        try { ctx.ui.notify(reason, "warning"); } catch { /* non-TUI */ }
        return { block: true, reason };
      }
      return undefined;
    });
  }

  // ── turn_end: record token usage + budget check (pi-codex-goal style) ──
  pi.on("turn_end", (event, _ctx) => {
    const msg = event.message as any;

    // ── usage_limited self-heal (quant02 2026-09-16 incident fix) ──
    // A completed assistant turn (stopReason other than "error") means the
    // provider is serving again: an active 429 (jdcloud "tokens limit for
    // minute") fails the generation itself. Resume without waiting for the
    // model to call update_goal — the incident showed GLM-5.3 stalling on the
    // old injection wording for 6+ rounds even when the user pasted the
    // exact command. budget_limited stays user-reserved (monotonic
    // tokensUsed would re-limit immediately).
    if (msg?.role === "assistant" && msg?.stopReason && msg.stopReason !== "error") {
      if (goalManager.getGoal()?.status === "usage_limited") {
        goalManager.resume("runtime");
        _ctx.ui.notify("Goal auto-resumed: provider rate-limit window cleared", "info");
      }
    }

    if (msg?.role === "assistant" && msg?.usage) {
      const tokens = (msg.usage.input || 0) + (msg.usage.output || 0);
      if (tokens > 0) {
        // B4: autoExtend goals report the stepped-up budget (autoExtendedTo)
        // instead of crossing (crossedBudget=false — the goal didn't stop).
        const { crossedBudget, autoExtendedTo, autoRenewed } = goalManager.recordTurn(tokens);
        if (crossedBudget) {
          _ctx.ui.notify("Goal budget exceeded — goal blocked.", "warning");
        } else if (autoRenewed) {
          _ctx.ui.notify(
            `Goal budget auto-renewed to ${autoRenewed.budget} (auto-renew #${autoRenewed.count}) — continuing.`,
            "info",
          );
        } else if (autoExtendedTo !== undefined) {
          _ctx.ui.notify(`Goal budget auto-extended to ${autoExtendedTo} (autoExtend goal).`, "info");
        }
        updateGoalStatusBar(_ctx);
      }
    }

    // ── A2 (spec §2): delegate token accounting ──
    // subagent children run in their own sessions; their usage never enters
    // the parent assistant msg.usage — pi aggregates it into the parent-side
    // toolResult.usage (pi-subagents subagent-executor withAggregatedToolUsage;
    // TurnEndEvent.toolResults, pi types.d.ts:828-835). Bill delegated child
    // tokens to the goal via recordTokenUsage (no turnsUsed: the turnBudget
    // keeps its parent-turn semantics). Known limit (documented in spec §7):
    // async/detached child completion notices don't carry usage upstream yet.
    const toolResults = (event as { toolResults?: Array<{ toolName?: string; usage?: { input?: number; output?: number } }> }).toolResults;
    if (Array.isArray(toolResults)) {
      let delegatedTokens = 0;
      for (const tr of toolResults) {
        if (tr?.toolName !== "subagent" || !tr.usage) continue;
        const t = (tr.usage.input || 0) + (tr.usage.output || 0);
        if (t > 0) delegatedTokens += t;
      }
      if (delegatedTokens > 0) {
        const { crossedBudget, autoExtendedTo, autoRenewed } = goalManager.recordTokenUsage(delegatedTokens);
        if (crossedBudget) {
          _ctx.ui.notify("Goal budget exceeded (delegated tokens) — goal blocked.", "warning");
        } else if (autoRenewed) {
          _ctx.ui.notify(
            `Goal budget auto-renewed to ${autoRenewed.budget} (auto-renew #${autoRenewed.count}, delegated tokens) — continuing.`,
            "info",
          );
        } else if (autoExtendedTo !== undefined) {
          _ctx.ui.notify(`Goal budget auto-extended to ${autoExtendedTo} (delegated tokens, autoExtend goal).`, "info");
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
  goalManager.registerCommands(pi);
}
