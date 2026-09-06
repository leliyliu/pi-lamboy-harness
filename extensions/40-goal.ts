// ============================================================
// Extension entry: Goal — create/get/update/set_goal_budget tools,
// /goal command, persistence (appendEntry + monotonic restore),
// budget detection on turn_end, overflow/429 recovery, compaction
// preservation, context injection, and the live footer badge.
//
// Filter out this file to drop goal lifecycle management.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { goalManager } from "../packages/core/goal";
import { GOAL_ENTRY_TYPE } from "../packages/core/goal/types";
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

  // ── turn_end: record token usage + budget check (pi-codex-goal style) ──
  pi.on("turn_end", (event, _ctx) => {
    const msg = event.message as any;
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
  goalManager.registerCommands(pi);
}
