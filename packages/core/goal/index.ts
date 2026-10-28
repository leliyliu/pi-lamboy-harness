// ============================================================
// Goal System — lifecycle + persistence + injection
// ============================================================

import type { GoalSnapshot, GoalStatus, GoalActor, GoalBudgetLimits, AutoRenewInfo } from "./types.ts";
import { goalState, setCurrentGoal, GOAL_ENTRY_TYPE, GOAL_LIMITED_ALLOWED_TOOLS, GOAL_LIMITED_ALLOWED_TOOLS_LABEL } from "./types.ts";
import { computeBudgetReport, budgetBandGuidance, liveWallClockMs } from "./budget.ts";
import { goalToEntryData, goalFromEntryData, reconstructGoalFromEntries } from "./persistence.ts";
import { registerGoalTools } from "./tools.ts";
import { registerGoalCommands } from "./commands.ts";
import { autoSwitchToNext } from "./queue.ts";
import type { PersistencePort } from "../ports.ts";

/** Mutate status on an existing goal snapshot (immutable style). */
function cloneSnapshot(s: GoalSnapshot, patch: Partial<GoalSnapshot>): GoalSnapshot {
  return { ...s, ...patch };
}

// ============================================================
// GoalManager — lifecycle + persistence + prompt injection
// ============================================================

export class GoalManager {
  private persistFn: ((data: GoalSnapshot | null) => void) | null = null;
  private appendEntryFn: ((type: string, data: any) => void) | null = null;
  // P0 (3): per-goal block-attempt counter for the blocked 3-round threshold.
  private blockAttempts = new Map<string, { reason: string | undefined; count: number }>();

  /** Bind a persistence callback (called every time goal changes) */
  setPersistence(fn: (data: GoalSnapshot | null) => void): void {
    this.persistFn = fn;
  }

  /** Bind appendEntry for persistence */
  setAppendEntry(fn: (type: string, data: any) => void): void {
    this.appendEntryFn = fn;
  }

  /**
   * Bind the host persistence port (write path). The adapter implements
   * this with pi.appendEntry; the fork implements it natively. Read path
   * is tryRestoreFromEntries() below, fed with fresh entries per session.
   */
  bindPersistence(port: PersistencePort): void {
    this.setPersistence((data) => {
      if (data) port.append(GOAL_ENTRY_TYPE, data);
    });
    this.setAppendEntry((type, data) => port.append(type, data));
  }

  /** Persist current goal or null (clear) */
  private persist(): void {
    if (this.persistFn) this.persistFn(goalState.current);
    // Also persist via appendEntry if available
    if (this.appendEntryFn && goalState.current) {
      const data = goalToEntryData(goalState.current);
      if (data) {
        this.appendEntryFn(GOAL_ENTRY_TYPE, data);
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Create a new active goal.
   * P0 (1): active guard — refuses to create when an active goal already exists,
   * unless `replace=true` is passed (caller explicitly acknowledges the overwrite).
   * Throws a descriptive Error so tool/command layers can surface it to the model/user.
   * B4 (spec §3): autoExtend (create_goal param, default false) — when true,
   * crossing the token budget steps it up instead of entering budget_limited
   * (same top-up cap as B3).
   */
  createGoal(
    objective: string,
    completionCriterion?: string,
    budgetLimits?: GoalBudgetLimits,
    actor: GoalActor = "user",
    replace: boolean = false,
    autoExtend: boolean = false,
  ): GoalSnapshot {
    // P0 (1): active guard
    if (goalState.current && goalState.current.status === "active" && !replace) {
      throw new Error("已有 active 目标,使用 replace=true 或 /goal replace 才能覆盖");
    }
    const goal: GoalSnapshot = {
      goalId: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      objective,
      completionCriterion,
      status: "active",
      lastActor: actor,
      lastActedAt: new Date().toISOString(),
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits,
      ...(autoExtend ? { autoExtend: true } : {}),
    };
    setCurrentGoal(goal);
    this.persist();
    return goal;
  }

  /** Get the current goal */
  getGoal(): GoalSnapshot | null {
    return goalState.current;
  }

  /** Apply actor+timestamp to any snapshot patch */
  private withActor(patch: Partial<GoalSnapshot>, actor: GoalActor): Partial<GoalSnapshot> {
    return { ...patch, lastActor: actor, lastActedAt: new Date().toISOString() };
  }

  /**
   * Update goal textual fields.
   * P0 (6): default to preserving the existing status; only override it when the
   * caller explicitly passes a `status` value. Passing `undefined` is treated as
   * "no override" and keeps the current status (NOT a forced reset to active).
   */
  editGoal(
    objective: string,
    completionCriterion: string | undefined,
    actor: GoalActor = "user",
    status: GoalStatus | undefined = undefined,
  ): GoalSnapshot | null {
    const g = goalState.current;
    if (!g) return null;
    const patch: Partial<GoalSnapshot> = { objective, completionCriterion };
    if (status !== undefined) patch.status = status;
    const updated = cloneSnapshot(g, this.withActor(patch, actor));
    setCurrentGoal(updated);
    this.persist();
    return updated;
  }

  /** Pause → paused (wall clock handling) */
  pause(actor: GoalActor = "user"): GoalSnapshot | null {
    const g = goalState.current;
    if (!g || g.status === "complete") return null;

    // Fold live wall clock interval into total
    const now = Date.now();
    let wallClockMs = g.wallClockMs;
    if (g.status === "active" && g.wallClockResumedAt !== undefined) {
      wallClockMs += Math.max(0, now - g.wallClockResumedAt);
    }

    const updated = cloneSnapshot(g, this.withActor({
      status: "paused" as GoalStatus,
      wallClockMs,
      wallClockResumedAt: undefined,
    }, actor));
    setCurrentGoal(updated);
    this.persist();
    return updated;
  }

  /** Resume paused/blocked → active (wall clock handling) */
  resume(actor: GoalActor = "user"): GoalSnapshot | null {
    const g = goalState.current;
    if (!g || g.status === "complete") return null;

    const updated = cloneSnapshot(g, this.withActor({
      status: "active" as GoalStatus,
      wallClockResumedAt: Date.now(),
      terminalReason: undefined, // Clear stop reason on resume
    }, actor));
    setCurrentGoal(updated);
    this.persist();
    // P0 (3): a resume from a (soft or hard) blocked state starts a fresh
    // 3-round window for any future block attempts.
    this.blockAttempts.delete(g.goalId);
    return updated;
  }

  /**
   * Block — with optional budget-limit check.
   * P0 (3): 3-round threshold. The same `reason` must be reported 3 consecutive
   * times before the goal actually enters the `blocked` status. The first two
   * attempts keep the existing status and only log internally; the counter
   * resets when `reason` changes (new reason starts a fresh 3-round window).
   * Once the goal is actually blocked, the counter for that goal is cleared.
   */
  block(reason?: string, actor: GoalActor = "system"): GoalSnapshot | null {
    const g = goalState.current;
    if (!g || g.status === "complete") return null;

    // P0 (3): block-attempt accounting
    const key = g.goalId;
    const prev = this.blockAttempts.get(key);
    let count = 1;
    if (prev && prev.reason === reason) {
      count = prev.count + 1;
    }
    this.blockAttempts.set(key, { reason, count });

    if (count < 3) {
      // Keep existing status; only log internally. Do NOT fold wall clock since
      // the goal's running state is unchanged.
      // eslint-disable-next-line no-console
      console.warn(
        `[goal] block attempt ${count}/3 for goal ${key} (reason=${JSON.stringify(reason)}); status remains "${g.status}"`,
      );
      return g;
    }

    // 3rd consecutive identical block attempt → actually enter blocked.
    // Fold live wall clock interval (matches prior behavior on real block).
    const now = Date.now();
    let wallClockMs = g.wallClockMs;
    if (g.status === "active" && g.wallClockResumedAt !== undefined) {
      wallClockMs += Math.max(0, now - g.wallClockResumedAt);
    }

    const updated = cloneSnapshot(g, this.withActor({
      status: "blocked" as GoalStatus,
      terminalReason: reason,
      wallClockMs,
      wallClockResumedAt: undefined,
    }, actor));
    setCurrentGoal(updated);
    this.persist();
    // Clear the counter once the goal is actually blocked.
    this.blockAttempts.delete(key);
    return updated;
  }

  /**
   * P0 (2): placeholder criterion verifier. The extension cannot actually run
   * verification today, so this only asserts the criterion is a non-empty string
   * (i.e. "criterion declared"). When a real verification interface is wired in
   * later, replace this body with a real check. `verified=true` from the caller
   * is what currently gates completion when a criterion is declared.
   */
  private verifyCriterion(criterion: string | undefined): boolean {
    return typeof criterion === "string" && criterion.trim().length > 0;
  }

  /**
   * Mark complete. Preserves completionSummary.
   * P0 (2): when `goal.completionCriterion` is declared (non-empty), the caller
   * MUST pass `verified=true` to complete; otherwise completion is refused and
   * the goal is left untouched. When no criterion is declared, completion is
   * allowed as before.
   */
  complete(actor: GoalActor = "user", summary?: string, verified: boolean = false): GoalSnapshot | null {
    const g = goalState.current;
    if (!g) return null;

    // P0 (2): criterion gate
    if (g.completionCriterion && g.completionCriterion.trim().length > 0) {
      if (!verified) {
        // Need explicit verification; do not change the goal.
        return null;
      }
      // Caller asserts completion; run placeholder check for parity with the
      // future real verifier. A declared-but-empty criterion would fail here,
      // which is the intended "criterion must actually be declared" rule.
      if (!this.verifyCriterion(g.completionCriterion)) {
        return null;
      }
    } else {
      // No criterion declared → free to complete. Still run the placeholder so
      // the code path is exercised; it returns false for empty/undefined and
      // we simply ignore that here (no-criterion ⇒ allowed).
      this.verifyCriterion(g.completionCriterion);
    }

    const now = Date.now();
    let wallClockMs = g.wallClockMs;
    if (g.status === "active" && g.wallClockResumedAt !== undefined) {
      wallClockMs += Math.max(0, now - g.wallClockResumedAt);
    }

    const updated = cloneSnapshot(g, this.withActor({
      status: "complete" as GoalStatus,
      wallClockMs,
      wallClockResumedAt: undefined,
      completionSummary: summary || g.completionSummary,
    }, actor));
    setCurrentGoal(updated);
    this.persist();

    const nextItem = autoSwitchToNext();
    if (nextItem) {
      this.createGoal(nextItem.objective, nextItem.completionCriterion, nextItem.budgetLimits, "runtime");
    }

    return updated;
  }

  /**
   * Clear the goal.
   * Also appends a tombstone entry (status "complete"): persist() skips a
   * null current goal, so without a tombstone the cleared goal's last entry
   * would remain the most recent one — and any restore-from-entries (next
   * session start, or the restore-if-empty at goal tool entry points) would
   * resurrect the cleared goal with its stale counters. Semantics:
   * an ended goal never rests on disk as restorable state.
   */
  clear(actor: GoalActor = "user"): void {
    const g = goalState.current;
    if (g) this.blockAttempts.delete(g.goalId);
    setCurrentGoal(null);
    this.persist();
    if (g && this.appendEntryFn) {
      const data = goalToEntryData(g);
      if (data) {
        this.appendEntryFn(GOAL_ENTRY_TYPE, { ...data, status: "complete" as GoalStatus });
      }
    }
  }

  /**
   * Pause on user interrupt (pauseOnInterrupt).
   * Called when user presses Esc, Ctrl+C, or any turn-level cancellation.
   */
  pauseOnInterrupt(reason?: string): GoalSnapshot | null {
    const g = goalState.current;
    if (!g || g.status !== "active") return null;
    return this.pause("user");
  }

  // ── Budget & Accounting ────────────────────────────────────────────────

  /**
   * Record a turn / token usage.
   * Returns `{ crossedBudget }` if this turn pushed over the budget.
   * Auto-blocks the goal when budget is exceeded.
   * B4 (spec §3): when the goal was created with autoExtend=true, a token
   * crossing steps the budget up by the extend step instead of blocking
   * (same cap as B3); `autoExtendedTo` then carries the new budget for the
   * caller's notify, and crossedBudget is false (the goal didn't stop).
   */
  recordTurn(tokens: number, actor: GoalActor = "runtime"): { crossedBudget: boolean; autoExtendedTo?: number; autoRenewed?: AutoRenewInfo } {
    const g = goalState.current;
    if (!g || g.status !== "active") return { crossedBudget: false };

    const now = Date.now();
    const deltaMs = g.wallClockResumedAt ? Math.max(0, now - g.wallClockResumedAt) : 0;

    const newTokens = g.tokensUsed + tokens;
    const newTurns = g.turnsUsed + 1;
    const newWallClockMs = g.wallClockMs + deltaMs;

    // C1 (2026-10-28): proactive headroom top-up happens BEFORE the crossing
    // check — the goal gains budget at the warn tier instead of being parked
    // exactly when it hits 100%. `autoExtend` goals keep their legacy
    // crossing-only extension (one extension mechanism per goal).
    // Finding (review of C1): a simultaneous turn/wall-clock crossing stops the
    // goal regardless of tokens, so spending a renewal there would be dead
    // weight — decide that first, exactly like the token crossing path below.
    const preLimits = g.budgetLimits ?? {};
    const turnOrWallCrossed =
      (preLimits.turnBudget !== undefined && preLimits.turnBudget > 0 && newTurns >= preLimits.turnBudget) ||
      (preLimits.wallClockBudgetMs !== undefined && preLimits.wallClockBudgetMs > 0 && newWallClockMs >= preLimits.wallClockBudgetMs);
    const headroom = g.autoExtend === true || turnOrWallCrossed
      ? undefined
      : this.headroomTopUp(newTokens);

    // Check all three budget types
    const limits = headroom
      ? { ...preLimits, tokenBudget: headroom.budget }
      : preLimits;
    const crossedTokens = limits.tokenBudget !== undefined && limits.tokenBudget > 0 && newTokens >= limits.tokenBudget;
    const crossedTurns = limits.turnBudget !== undefined && limits.turnBudget > 0 && newTurns >= limits.turnBudget;
    const crossedWallClock = limits.wallClockBudgetMs !== undefined && limits.wallClockBudgetMs > 0 && newWallClockMs >= limits.wallClockBudgetMs;

    const crossed = crossedTokens || crossedTurns || crossedWallClock;
    let newStatus: GoalStatus = g.status;
    let terminalReason = crossed ? "Budget exceeded" : g.terminalReason;
    let autoExtendedTo: number | undefined;
    let autoRenewed: AutoRenewInfo | undefined;
    let newLimits = limits;
    let topUps = g.topUps;
    let autoRenewals = headroom ? headroom.count : g.autoRenewals ?? 0;

    if (crossed) {
      const max = this.topUpMax();
      const underCap = max === 0 || (g.topUps ?? 0) < max;
      // 2026-10-26 auto-renew: a pure token crossing is excused by the
      // runtime policy (default +800k, max 10, total cap 8M) before the
      // goal is allowed to stop. turn/wall-clock crossings are NOT excused.
      const autoRenewable = crossedTokens && !crossedTurns && !crossedWallClock &&
        this.canAutoRenew(autoRenewals);
      // B4: a token crossing on an autoExtend goal is excused by extending the
      // budget — but only when nothing else stops the goal. Finding 2 fix
      // (review 2026-10-19): decide the stop FIRST; a simultaneous
      // turn/wall-clock crossing must not consume a top-up (the goal stops
      // anyway — extending would be dead weight, and would misreport a
      // token-crossing goal as "blocked" instead of budget_limited).
      const tokenExcusable = crossedTokens && g.autoExtend === true && underCap;
      const stillCrossed = (crossedTurns || crossedWallClock) ||
        (crossedTokens && !tokenExcusable && !autoRenewable);
      if (stillCrossed) {
        // Distinguish budget_limited (tokenBudget) from blocked (other budgets)
        newStatus = crossedTokens && !tokenExcusable ? "budget_limited" : "blocked";
        terminalReason = "Budget exceeded";
      } else if (tokenExcusable) {
        // Pure token crossing on an autoExtend goal: extend and keep running.
        const step = this.extendStep();
        autoExtendedTo = (limits.tokenBudget ?? 0) + step;
        newLimits = { ...limits, tokenBudget: autoExtendedTo };
        topUps = (g.topUps ?? 0) + 1;
        terminalReason = g.terminalReason;
      } else if (autoRenewable) {
        const next = this.autoRenewBudget(newTokens);
        if (next !== undefined) {
          autoExtendedTo = next;
          newLimits = { ...limits, tokenBudget: next };
          autoRenewals += 1;
          autoRenewed = { budget: next, count: autoRenewals, reason: "crossing" };
          terminalReason = g.terminalReason;
        } else {
          // Total budget cap reached — stop exactly like the old path.
          newStatus = "budget_limited";
          terminalReason = "Budget exceeded";
        }
      }
    }

    if (headroom) {
      // Pre-paid: the budget was raised above this turn's usage, so nothing
      // crosses. Report it through the same fields so the UI/notify path is
      // shared with the crossing renewal.
      autoExtendedTo = headroom.budget;
      autoRenewed = { ...headroom, reason: "headroom" };
    }

    setCurrentGoal(cloneSnapshot(g, this.withActor({
      turnsUsed: newTurns,
      tokensUsed: newTokens,
      wallClockMs: newWallClockMs,
      wallClockResumedAt: now, // Reset wall clock interval
      status: newStatus,
      terminalReason,
      // Nit 8 (review): write budgetLimits only when autoExtend changed it —
      // unconditional write persisted `budgetLimits: {}` for limit-less goals.
      ...(autoExtendedTo !== undefined ? { budgetLimits: newLimits } : {}),
      ...(topUps !== g.topUps ? { topUps } : {}),
      ...(autoRenewals !== (g.autoRenewals ?? 0) ? { autoRenewals } : {}),
    }, actor)));
    this.persist();
    // crossedBudget = the goal actually stopped (autoExtend alone doesn't stop).
    const stopped = newStatus !== "active";
    return { crossedBudget: stopped, autoExtendedTo, ...(autoRenewed ? { autoRenewed } : {}) };
  }

  /**
   * Record token usage without incrementing turns.
   * A2 (spec §2): used for delegated subagent child tokens — their usage
   * lands in toolResult.usage, never in the parent assistant msg.usage.
   * Checks the token budget like recordTurn so delegated tokens alone can
   * also flip the goal to budget_limited (A2c: child-first accumulation must
   * not skip the crossing check). B4: autoExtend goals step the budget up
   * here too. Turns/wall-clock budgets can't newly cross here — neither
   * counter moves in this path.
   * Silent persist (no UI update); the caller refreshes the badge.
   */
  recordTokenUsage(delta: number): { crossedBudget: boolean; autoExtendedTo?: number; autoRenewed?: AutoRenewInfo } {
    const g = goalState.current;
    // Finding 1 fix (review 2026-10-19): also accumulate while budget_limited —
    // the same turn's parent msg may have just crossed the budget (turn_end
    // processes msg.usage first), and silently dropping that turn's delegated
    // tokens undercounts the goal. We only skip state flips/extension when
    // not active (no double-transition out of a terminal-ish state).
    if (!g || (g.status !== "active" && g.status !== "budget_limited")) {
      return { crossedBudget: false };
    }
    const accumulating = g.status === "active";

    const newTokens = g.tokensUsed + Math.max(0, delta);
    // C1 (2026-10-28): same proactive headroom policy as recordTurn, so a
    // delegated-token spike gains budget before it becomes a crossing. Skipped
    // when a turn/wall-clock budget already stops the goal (tokens can't fix it).
    const preLimits = g.budgetLimits ?? {};
    const turnOrWallExhausted =
      (preLimits.turnBudget !== undefined && preLimits.turnBudget > 0 && g.turnsUsed >= preLimits.turnBudget) ||
      (preLimits.wallClockBudgetMs !== undefined && preLimits.wallClockBudgetMs > 0 && liveWallClockMs(g) >= preLimits.wallClockBudgetMs);
    const headroom = accumulating && g.autoExtend !== true && !turnOrWallExhausted
      ? this.headroomTopUp(newTokens)
      : undefined;
    const limits = headroom
      ? { ...preLimits, tokenBudget: headroom.budget }
      : preLimits;
    const crossedTokens = limits.tokenBudget !== undefined && limits.tokenBudget > 0 && newTokens >= limits.tokenBudget;

    let autoExtendedTo: number | undefined;
    let autoRenewed: AutoRenewInfo | undefined;
    let newLimits = limits;
    let topUps = g.topUps;
    let autoRenewals = headroom ? headroom.count : g.autoRenewals ?? 0;
    let status: GoalStatus | undefined;
    let terminalReason: string | undefined;

    if (accumulating && crossedTokens) {
      const max = this.topUpMax();
      const underCap = max === 0 || (g.topUps ?? 0) < max;
      const autoRenewable = this.canAutoRenew(autoRenewals);
      if (g.autoExtend && underCap) {
        const step = this.extendStep();
        autoExtendedTo = (limits.tokenBudget ?? 0) + step;
        newLimits = { ...limits, tokenBudget: autoExtendedTo };
        topUps = (g.topUps ?? 0) + 1;
      } else if (autoRenewable) {
        const next = this.autoRenewBudget(newTokens);
        if (next !== undefined) {
          autoExtendedTo = next;
          newLimits = { ...limits, tokenBudget: next };
          autoRenewals += 1;
          autoRenewed = { budget: next, count: autoRenewals, reason: "crossing" };
        } else {
          status = "budget_limited";
          terminalReason = "Budget exceeded";
        }
      } else {
        status = "budget_limited";
        terminalReason = "Budget exceeded";
      }
    }

    if (headroom) {
      autoExtendedTo = headroom.budget;
      autoRenewed = { ...headroom, reason: "headroom" };
    }

    setCurrentGoal(cloneSnapshot(g, {
      tokensUsed: newTokens,
      ...(status !== undefined ? { status, terminalReason } : {}),
      // Nit 8 (review): budgetLimits only when an extension changed it.
      ...(autoExtendedTo !== undefined ? { budgetLimits: newLimits } : {}),
      ...(topUps !== g.topUps ? { topUps } : {}),
      ...(autoRenewals !== (g.autoRenewals ?? 0) ? { autoRenewals } : {}),
    }));
    if (this.persistFn) this.persistFn(goalState.current);
    // crossedBudget = this call actually flipped/kept the goal stopped by
    // tokens (not: merely accumulated over an already-limited budget).
    return { crossedBudget: status === "budget_limited", autoExtendedTo, ...(autoRenewed ? { autoRenewed } : {}) };
  }

  /**
   * Increment turn count.
   */
  incrementTurn(): void {
    const g = goalState.current;
    if (!g || g.status !== "active") return;

    const now = Date.now();
    const deltaMs = g.wallClockResumedAt ? Math.max(0, now - g.wallClockResumedAt) : 0;

    setCurrentGoal(cloneSnapshot(g, {
      turnsUsed: g.turnsUsed + 1,
      wallClockMs: g.wallClockMs + deltaMs,
      wallClockResumedAt: now,
    }));
    // Silent persist
    if (this.persistFn) this.persistFn(goalState.current);
  }

  /**
   * Set budget limits on the current goal.
   */
  setBudgetLimits(limits: GoalBudgetLimits, actor: GoalActor = "user"): GoalSnapshot | null {
    const g = goalState.current;
    if (!g) return null;

    const updated = cloneSnapshot(g, this.withActor({
      budgetLimits: { ...g.budgetLimits, ...limits },
    }, actor));
    setCurrentGoal(updated);
    this.persist();
    return updated;
  }

  // ── Usage/Budget Limited Detection (@narumitw/pi-goal style) ──────────

  /**
   * Mark goal as usage_limited (provider quota exhausted, e.g., 429 error).
   */
  markUsageLimited(reason?: string, actor: GoalActor = "runtime"): GoalSnapshot | null {
    const g = goalState.current;
    if (!g || g.status !== "active") return null;
    const now = Date.now();
    let wallClockMs = g.wallClockMs;
    if (g.wallClockResumedAt !== undefined) {
      wallClockMs += Math.max(0, now - g.wallClockResumedAt);
    }
    const updated = cloneSnapshot(g, this.withActor({
      status: "usage_limited" as GoalStatus,
      terminalReason: reason ?? "Provider quota exhausted",
      wallClockMs,
      wallClockResumedAt: undefined,
    }, actor));
    setCurrentGoal(updated);
    this.persist();
    return updated;
  }

  /**
   * Mark goal as budget_limited (user token budget exceeded).
   */
  markBudgetLimited(reason?: string, actor: GoalActor = "runtime"): GoalSnapshot | null {
    const g = goalState.current;
    if (!g || g.status !== "active") return null;
    const now = Date.now();
    let wallClockMs = g.wallClockMs;
    if (g.wallClockResumedAt !== undefined) {
      wallClockMs += Math.max(0, now - g.wallClockResumedAt);
    }
    const updated = cloneSnapshot(g, this.withActor({
      status: "budget_limited" as GoalStatus,
      terminalReason: reason ?? "Token budget exceeded",
      wallClockMs,
      wallClockResumedAt: undefined,
    }, actor));
    setCurrentGoal(updated);
    this.persist();
    return updated;
  }

  /**
   * Detect 429/rate-limit errors and mark as usage_limited.
   */
  detectProviderLimitError(errorMessage: string | undefined): boolean {
    if (!errorMessage) return false;
    const g = goalState.current;
    if (!g || g.status !== "active") return false;
    const isProviderLimit = /429|rate.?limit|quota.?exhausted|usage.?limit|insufficient.?balance/i.test(errorMessage);
    if (isProviderLimit) {
      this.markUsageLimited(errorMessage);
      return true;
    }
    return false;
  }

  /**
   * B3 (spec §3): top-up env ceiling. 0 = unlimited. Default 3.
   */
  private topUpMax(): number {
    const raw = process.env.PI_LAMBOY_GOAL_TOPUP_MAX;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : 3;
  }

  /**
   * B3/B4 (spec §3): auto top-up step (B4 extension amount). Default 500000.
   * Kept for the legacy autoExtend path (tests pin this value); the 2026-10-26
   * auto-renew/handoff policy uses renewStep() instead (default +800k).
   */
  private extendStep(): number {
    const raw = process.env.PI_LAMBOY_GOAL_EXTEND_STEP;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n > 0 ? n : 500000;
  }

  /**
   * 2026-10-26 auto-renew / handoff step. Default 800000
   * (PI_LAMBOY_GOAL_RENEW_STEP overrides).
   */
  private renewStep(): number {
    const raw = process.env.PI_LAMBOY_GOAL_RENEW_STEP;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n > 0 ? n : 800000;
  }

  // ── 2026-10-26 auto-renew policy ────────────────────────────────────
  // Runtime renews an exhausted token budget instead of parking the goal.
  // Decoupled from topUps (which stays the /goal resume budget): auto-renew
  // must not silently consume the user's manual allowance.

  /** Global switch: PI_LAMBOY_GOAL_AUTORENEW=0 disables (default on). */
  private autoRenewEnabled(): boolean {
    return process.env.PI_LAMBOY_GOAL_AUTORENEW !== "0";
  }

  /** Renewal cap: PI_LAMBOY_GOAL_AUTORENEW_MAX (default 10, 0 = unlimited). */
  private autoRenewMax(): number {
    const raw = process.env.PI_LAMBOY_GOAL_AUTORENEW_MAX;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : 10;
  }

  /** Hard total cap: PI_LAMBOY_GOAL_MAX_TOKENS (default 8M, 0 = unlimited). */
  private maxTotalTokens(): number {
    const raw = process.env.PI_LAMBOY_GOAL_MAX_TOKENS;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : 8_000_000;
  }

  private canAutoRenew(renewals: number): boolean {
    if (!this.autoRenewEnabled()) return false;
    const max = this.autoRenewMax();
    return !(max > 0 && renewals >= max);
  }

  /**
   * Next token budget after a renewal, or undefined when the hard total cap
   * makes another extension impossible (used >= cap).
   */
  private autoRenewBudget(used: number): number | undefined {
    const cap = this.maxTotalTokens();
    if (cap > 0 && used >= cap) return undefined;
    const step = this.renewStep();
    const next = Math.max(used + step, Math.ceil((used * 1.25) / 50000) * 50000);
    return cap > 0 ? Math.min(next, cap) : next;
  }

  // ── 2026-10-28 proactive headroom top-up (C1) ───────────────────────

  /**
   * Headroom tier in percent: PI_LAMBOY_GOAL_TOPUP_AT (default 80, 0 or
   * out-of-range disables). At/above this share of the token budget the
   * runtime raises the budget BEFORE the crossing, so the goal never parks.
   */
  private topUpAtPct(): number {
    const raw = process.env.PI_LAMBOY_GOAL_TOPUP_AT;
    if (raw === undefined) return 80;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 100 ? n : 0;
  }

  /**
   * C1: should this usage level get a pre-exhaustion top-up, and to what?
   * Pure: mutates nothing (callers apply the returned budget). Same caps as
   * the crossing renewal (autoRenewMax / PI_LAMBOY_GOAL_MAX_TOKENS), so the
   * two paths cannot bypass each other's limits.
   */
  private headroomTopUp(used: number): { budget: number; count: number } | undefined {
    const g = goalState.current;
    if (!g) return undefined;
    const budget = g.budgetLimits?.tokenBudget;
    if (budget === undefined || budget <= 0) return undefined;
    const pct = this.topUpAtPct();
    if (pct <= 0) return undefined;
    if (used * 100 < budget * pct) return undefined;
    const renewals = g.autoRenewals ?? 0;
    if (!this.canAutoRenew(renewals)) return undefined;
    const next = this.autoRenewBudget(used);
    if (next === undefined || next <= budget) return undefined;
    return { budget: next, count: renewals + 1 };
  }

  /**
   * C2 (2026-10-28): re-entry renewal — rescue a goal that is ALREADY over
   * its token budget (restored from a previous session/process, or renewed
   * once too late) instead of leaving it parked in budget_limited until the
   * user runs `/goal resume`.
   *
   * Called by the extension on every `context` event (before injection), so
   * a restored budget_limited goal is active again on the very first model
   * request. Only token overage qualifies: turn/wall-clock budgets are
   * cumulative across sessions, so adding tokens cannot help those.
   */
  autoRecoverBudget(
    actor: GoalActor = "runtime",
  ): { extended: boolean; newBudget: number; count: number; resumed: boolean } | null {
    const g = goalState.current;
    if (!g || (g.status !== "active" && g.status !== "budget_limited")) return null;
    const budget = g.budgetLimits?.tokenBudget;
    if (budget === undefined || budget <= 0) return null;

    const turnWallExhausted =
      (g.budgetLimits?.turnBudget !== undefined && g.turnsUsed >= g.budgetLimits.turnBudget) ||
      (g.budgetLimits?.wallClockBudgetMs !== undefined &&
        liveWallClockMs(g) >= g.budgetLimits.wallClockBudgetMs);
    if (turnWallExhausted) return null;

    const renewals = g.autoRenewals ?? 0;
    const wasLimited = g.status === "budget_limited";
    const overBudget = g.tokensUsed >= budget;

    // Limited but not over its token budget (e.g. the user raised the budget
    // without resuming): nothing to extend, just lift the gate.
    if (!overBudget) {
      if (!wasLimited) return null;
      const resumed = this.resume(actor);
      if (!resumed) return null;
      return { extended: false, newBudget: budget, count: renewals, resumed: true };
    }

    if (!this.canAutoRenew(renewals)) return null;
    const next = this.autoRenewBudget(g.tokensUsed);
    if (next === undefined || next <= budget) return null;

    const patch: Partial<GoalSnapshot> = {
      budgetLimits: { ...g.budgetLimits, tokenBudget: next },
      autoRenewals: renewals + 1,
      status: "active" as GoalStatus,
      wallClockResumedAt: Date.now(),
      terminalReason: undefined,
    };
    const updated = cloneSnapshot(g, this.withActor(patch, actor));
    setCurrentGoal(updated);
    this.persist();
    return { extended: true, newBudget: next, count: renewals + 1, resumed: wasLimited };
  }

  /** B3: public read-only accessor for UI copy (/goal resume notify). */
  topUpMaxForDisplay(): number | null {
    const max = this.topUpMax();
    return max === 0 ? null : max;
  }

  /**
   * B3 (spec §3): resume via the USER entry point (/goal resume), with
   * automatic budget top-up for the resume trap.
   *
   * The trap: resume() only flips status; tokensUsed is monotonic and the
   * tokenBudget is unchanged, so the very next recordTurn() re-enters
   * budget_limited (crossedTokens: newTokens >= tokenBudget). The user's
   * "resume" looked like a no-op.
   *
   * Policy (D3): when resuming an over-budget budget_limited goal, raise
   * tokenBudget to max(tokensUsed + 500k, ceil(tokensUsed * 1.25 / 50k) * 50k)
   * — at least another 500k, or 25% headroom, whichever is larger, 50k-aligned.
   * Capped at PI_LAMBOY_GOAL_TOPUP_MAX top-ups (default 3, 0 = unlimited);
   * at the cap the resume still proceeds (explicit user decision) but the
   * budget is left untouched (kind="limit-reached").
   *
   * Non-budget states (paused/blocked/usage_limited/under-budget) resume as
   * before (kind="resumed"). The MODEL path (update_goal status="active")
   * remains excluded — LLM self-recovery for budget_limited stays a no-op
   * (10b semantics preserved; auto-renewal is user-entry-point only).
   */
  resumeWithTopUp(
    actor: GoalActor = "user",
  ): { kind: "resumed" | "topped-up" | "limit-reached" | "none"; goal: GoalSnapshot | null; newBudget?: number; topUps?: number } | null {
    const g = goalState.current;
    if (!g || g.status === "complete") return { kind: "none", goal: null };

    const overBudget =
      g.status === "budget_limited" &&
      g.budgetLimits?.tokenBudget !== undefined &&
      g.tokensUsed >= g.budgetLimits.tokenBudget;

    if (!overBudget) {
      const resumed = this.resume(actor);
      return resumed ? { kind: "resumed", goal: resumed } : { kind: "none", goal: null };
    }

    const max = this.topUpMax();
    const usedTopUps = g.topUps ?? 0;
    if (max > 0 && usedTopUps >= max) {
      const resumed = this.resume(actor);
      return resumed ? { kind: "limit-reached", goal: resumed } : { kind: "none", goal: null };
    }

    const newBudget = Math.max(
      g.tokensUsed + 500000,
      Math.ceil((g.tokensUsed * 1.25) / 50000) * 50000,
    );
    this.setBudgetLimits({ tokenBudget: newBudget }, actor);
    const resumed = this.resume(actor);
    if (!resumed) return { kind: "none", goal: null };
    const updated = cloneSnapshot(resumed, this.withActor({ topUps: usedTopUps + 1 }, actor));
    setCurrentGoal(updated);
    this.persist();
    return { kind: "topped-up", goal: updated, newBudget, topUps: usedTopUps + 1 };
  }

  /**
   * 2026-10-26 handoff renewal: `/handoff` switches to a NEW session via
   * ctx.newSession({ parentSession }), which does NOT copy the old session's
   * entries. The goal however lives in this process-level singleton, so the
   * new session would inherit an exhausted goal (budget_limited + tokensUsed
   * over budget) and every tool would hit the gate — the exact reason a
   * handoff appeared to "not extend the budget".
   *
   * This method (called from handoff/commands.ts inside newSession's `setup`,
   * which receives the writable new-session SessionManager):
   *   1. raises tokenBudget to max(used + step, 25% headroom), capped at the
   *      hard total cap (same policy as auto-renew);
   *   2. resumes budget_limited → active (handoff is an explicit user action);
   *   3. ALWAYS writes the goal entry through `append` so the new session owns
   *      the state (the old pi.appendEntry still targets the disposed session;
   *      without this, a handoff session that never runs a turn loses the goal
   *      on process restart).
   *
   * Env: PI_LAMBOY_HANDOFF_GOAL_RENEW=0 disables (default on);
   *      PI_LAMBOY_GOAL_AUTORENEW=0 also disables it (master switch).
   */
  renewForHandoff(
    append?: (type: string, data: unknown) => void,
  ): { renewed: boolean; newBudget?: number; resumed: boolean } {
    const g = goalState.current;
    if (!g || g.status === "complete") return { renewed: false, resumed: false };

    const enabled =
      process.env.PI_LAMBOY_HANDOFF_GOAL_RENEW !== "0" && this.autoRenewEnabled();
    const patch: Partial<GoalSnapshot> = {};
    let newBudget: number | undefined;

    const budget = g.budgetLimits?.tokenBudget;
    // A turn/wall-clock exhaustion is NOT solved by a handoff (the counters are
    // cumulative across sessions), so never extend or resume in that case —
    // the goal would be blocked again on the very next turn. Only token
    // exhaustion qualifies (review Finding 2).
    const turnWallExhausted =
      (g.budgetLimits?.turnBudget !== undefined && g.turnsUsed >= g.budgetLimits.turnBudget) ||
      (g.budgetLimits?.wallClockBudgetMs !== undefined &&
        liveWallClockMs(g) >= g.budgetLimits.wallClockBudgetMs);
    if (enabled && !turnWallExhausted && budget !== undefined && budget > 0) {
      const next = this.autoRenewBudget(g.tokensUsed);
      if (next !== undefined && next > budget) {
        newBudget = next;
        patch.budgetLimits = { ...g.budgetLimits, tokenBudget: next };
      }
    }

    const exhausted = g.status === "budget_limited";
    // Only resume when the budget actually moved: at the hard total cap a
    // handoff cannot help, so the goal must stay budget_limited.
    if (exhausted && enabled && newBudget !== undefined) {
      patch.status = "active";
      patch.wallClockResumedAt = Date.now();
      patch.terminalReason = undefined;
    }

    const updated = Object.keys(patch).length > 0
      ? cloneSnapshot(g, this.withActor(patch, "runtime"))
      : g;
    if (updated !== g) setCurrentGoal(updated);

    const data = goalToEntryData(updated);
    if (data) {
      if (append) append(GOAL_ENTRY_TYPE, data);
      else if (this.appendEntryFn) this.appendEntryFn(GOAL_ENTRY_TYPE, data);
    }

    return { renewed: newBudget !== undefined, newBudget, resumed: exhausted && newBudget !== undefined };
  }

  /**
   * B1 (spec §3) / C3 (2026-10-28): wrap-up for budget_limited.
   *
   * History: the 2026-10-19 design assumed exhaustion always needed a handoff,
   * so this text ordered "call the handoff tool NOW". The 2026-10-26 runtime
   * auto-renew made that obsolete — a handoff cannot add budget (the budget is
   * per goal and follows the session), so parking a briefing was pure loss:
   * the user was forced into /handoff while the runtime could have continued.
   * The wrap-up now asks for a short status report only; recovery is
   * automatic once the budget covers usage (autoRecoverBudget).
   */
  private buildBudgetLimitedWrapUp(statusLabel: string): string {
    return [
      `⚠️ ${statusLabel}. Allowed tools right now: ${GOAL_LIMITED_ALLOWED_TOOLS_LABEL} (nothing else).`,
      ``,
      `This is the automatic-renewal hard stop: the goal hit the total token cap ` +
        `(PI_LAMBOY_GOAL_MAX_TOKENS / PI_LAMBOY_GOAL_AUTORENEW_MAX), or auto-renewal is disabled ` +
        `(PI_LAMBOY_GOAL_AUTORENEW=0). A handoff does NOT add budget — the budget belongs to the ` +
        `goal and travels with it — so do not write a handoff briefing for budget reasons.`,
      ``,
      `Do this now:`,
      `1. Give a 2-3 line wrap-up: what is done, what remains, and the token budget the rest needs.`,
      `2. Stop tool-heavy goal work.`,
      ``,
      `The user unblocks it with set_goal_budget (or /goal resume); once the budget covers usage ` +
        `the runtime resumes the goal automatically, so no handoff is needed to continue.`,
    ].join("\n");
  }

  /**
   * Build wrap-up instruction for budget_limited/usage_limited goals.
   *
   * usage_limited (provider 429) is a temporary external limit. The window
   * is OBSERVABLE from inside: while it is active the generation itself
   * fails, so any response the model produces proves the window cleared.
   * The instruction therefore demands immediate self-recovery via
   * update_goal(status="active") — the old "tool calls are blocked / once
   * the window clears you may call" wording made GLM-5.3 treat EVERY tool
   * as blocked and the recovery condition as unknowable, stalling the
   * goal for 6+ rounds even when the user pasted the exact command
   * (quant02 incident, session 2026-09-16T02-40-50).
   *
   * budget_limited (user tokenBudget) is normally rescued automatically by
   * the runtime (auto-renew at the warn tier / autoRecoverBudget on entry);
   * this text only appears at the hard total cap, where it asks for a short
   * wrap-up instead of a handoff (C3, 2026-10-28).
   */
  buildWrapUpInjection(): string | undefined {
    const g = goalState.current;
    if (!g) return undefined;
    if (g.status !== "budget_limited" && g.status !== "usage_limited") return undefined;
    const statusLabel = g.status === "budget_limited" ? "Token budget exceeded" : "Provider quota exhausted";
    if (g.status === "usage_limited") {
      return [
        `⚠️ ${statusLabel} — the goal is paused as usage_limited.`,
        ``,
        `The rate-limit window has ALREADY cleared: you are generating this very response, and an active 429 would have failed the generation itself.`,
        ``,
        `Resume now:`,
        `1. Call update_goal(status="active") — this tool and get_goal are always available while usage_limited.`,
        `2. Continue working on the goal where it left off.`,
        ``,
        `Do NOT call create_goal. Do NOT write a wrap-up summary — the goal is paused, not ended.`,
      ].join("\n");
    }
    return this.buildBudgetLimitedWrapUp(statusLabel);
  }

  /**
   * Check if tool execution should be blocked.
   * @narumitw/pi-goal style: block stale tool calls after budget exhaustion.
   */
  shouldBlockTool(toolName: string, toolGoalId?: string): boolean {
    const g = goalState.current;
    if (!g) return false;

    // Block stale tool calls (tool from old goal)
    if (toolGoalId && toolGoalId !== g.goalId) {
      return true;
    }

    // Block all tools when budget/usage limited. B2 (spec §3): the whitelist
    // now includes `handoff` — the exhausted turn must still be able to park
    // the handoff briefing (B1). Enforced by the tool_call gate in
    // extensions/40-goal.ts (this used to be defined but never wired).
    // Nit 5 (review 2026-10-19): single source GOAL_LIMITED_ALLOWED_TOOLS in
    // types.ts — shared with the wrap-up text and the gate reason.
    if (g.status !== "budget_limited" && g.status !== "usage_limited") return false;
    if (GOAL_LIMITED_ALLOWED_TOOLS.includes(toolName)) return false;
    return true;
  }

  /**
   * Get current goal ID for tool tagging.
   */
  getCurrentGoalId(): string | null {
    return goalState.current?.goalId ?? null;
  }

  // ── Continuation Messages (@narumitw/pi-goal style) ───────────────────

  /**
   * Build continuation message for automatic goal continuation.
   * @narumitw/pi-goal style: send continuation after agent settles.
   */
  buildContinuationMessage(): string | undefined {
    const g = goalState.current;
    if (!g || g.status !== "active") return undefined;

    const parts = [
      `Continue working on the goal.`,
      `Objective: ${g.objective.slice(0, 100)}`,
    ];

    if (g.completionCriterion) {
      parts.push(`Completion criterion: ${g.completionCriterion}`);
    }

    const budgetLine = this.budgetBandGuidance();
    if (budgetLine) {
      parts.push(budgetLine);
    }

    parts.push(`Turns: ${g.turnsUsed}, Tokens: ${g.tokensUsed}`);

    return parts.join("\n");
  }

  /**
   * Build goal ID tag for tool calls (@narumitw/pi-goal style).
   * Used to detect stale tool calls.
   */
  buildGoalIdTag(): string | undefined {
    const g = goalState.current;
    if (!g || g.status !== "active") return undefined;
    return `[goal_id:${g.goalId}]`;
  }

  // ── Prompt Injection ───────────────────────────────────────────────────

  /**
   * Budget guidance string for prompt injection.
   */
  budgetBandGuidance(): string | undefined {
    const g = goalState.current;
    return budgetBandGuidance(g);
  }

  /** Build summary line for display */
  formatSummary(): string {
    const g = goalState.current;
    if (!g) return "No goal set.";
    const badge: Record<string, string> = {
      active: "Active", paused: "Paused", blocked: "Blocked", complete: "Complete",
      usage_limited: "Usage Limited", budget_limited: "Budget Limited",
    };
    const b = badge[g.status] ?? g.status;
    const reason = g.terminalReason ? ` (${g.terminalReason})` : "";
    const actor = g.lastActor !== "system" ? ` by ${g.lastActor}` : "";
    return `${b}: ${g.objective.slice(0, 80)}${reason}${actor}  [turns:${g.turnsUsed} tokens:${g.tokensUsed}]`;
  }

  /** Build a GoalPanel-style formatted report */
  formatGoalPanel(goal?: GoalSnapshot): string {
    const g = goal || goalState.current;
    if (!g) return "No goal set.";

    const lines: string[] = [];

    // Objective (blockquote style)
    lines.push(`\u258C ${g.objective}`);
    
    // Completion criterion
    if (g.completionCriterion) {
      lines.push(`\u258C \u2713 ${g.completionCriterion}`);
    }
    
    lines.push("");

    // Status
    const statusDot = g.status === "active" ? "\u25CF" : g.status === "blocked" ? "\u25CF" : "\u25CB";
    lines.push(`${statusDot} Status     ${g.status}${g.terminalReason ? ` \u2014 ${g.terminalReason}` : ""}`);
    
    // Running duration
    const durationMs = liveWallClockMs(g);
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    lines.push(`  Running    ${durationStr}`);
    
    // Turns
    const turnBudget = g.budgetLimits?.turnBudget;
    const turnsStr = turnBudget ? `${g.turnsUsed}/${turnBudget}` : `${g.turnsUsed}`;
    lines.push(`  Turns      ${turnsStr}`);
    
    // Tokens
    if (g.tokensUsed > 0) {
      const tokStr = g.tokensUsed < 1000 ? `${g.tokensUsed}` : g.tokensUsed < 10000 ? `${(g.tokensUsed / 1000).toFixed(1)}k` : `${Math.round(g.tokensUsed / 1000)}k`;
      lines.push(`  Tokens     ${tokStr}`);
    }
    
    // Stop condition
    if (turnBudget) {
      lines.push(`  Stop       after ${turnBudget} turns (${g.turnsUsed}/${turnBudget})`);
    } else if (g.budgetLimits?.tokenBudget) {
      lines.push(`  Stop       after ${g.budgetLimits.tokenBudget} tokens`);
    } else if (g.budgetLimits?.wallClockBudgetMs) {
      const wallMins = Math.floor(g.budgetLimits.wallClockBudgetMs / 60000);
      lines.push(`  Stop       after ${wallMins} minutes`);
    } else {
      lines.push(`  Stop       (no stop condition)`);
    }

    return lines.join("\n");
  }

  /**
   * Build Goal Badge for footer.
   * Format: [goal ● active · 4m · 7/20 turns]
   */
  buildFooterBadge(): string | undefined {
    const g = goalState.current;
    if (!g || g.status === "complete") return undefined;

    // Status dot color: active=primary, blocked=warning, paused=muted
    const dot = g.status === "active" ? "●" : g.status === "blocked" ? "●" : "○";
    
    // Duration
    const durationMs = liveWallClockMs(g);
    const durationMin = Math.floor(durationMs / 60000);
    const durationSec = Math.floor((durationMs % 60000) / 1000);
    const duration = durationMin > 0 ? `${durationMin}m` : `${durationSec}s`;
    
    // Turns (with budget if set)
    const turnBudget = g.budgetLimits?.turnBudget;
    const turns = turnBudget ? `${g.turnsUsed}/${turnBudget}` : `${g.turnsUsed}`;
    
    return `[goal ${dot} ${g.status} · ${duration} · ${turns} turns]`;
  }

  /**
   * Get status color for Goal Badge (for theme integration).
   * Return type is the pi-tui ThemeColor subset used by the badge.
   */
  getFooterBadgeColor(): "muted" | "accent" | "warning" | "error" {
    const g = goalState.current;
    if (!g) return "muted";
    switch (g.status) {
      case "active": return "accent";
      case "blocked": return "warning";
      case "usage_limited":
      case "budget_limited": return "error";
      default: return "muted";
    }
  }

  /**
   * A1 (spec §2): pre-authorized delegation guidance for active goals.
   * The subagent tool's own (pinned) description says "only when the operator
   * asked" — a goal created by the user IS that operator authorization, so
   * the goal injection carries it every turn. Self-contained wording (no
   * reference to AGENTS.md). env PI_LAMBOY_GOAL_DELEGATION=0 disables.
   */
  private buildDelegationGuidance(): string | undefined {
    if (process.env.PI_LAMBOY_GOAL_DELEGATION === "0") return undefined;
    return [
      `Delegation (pre-authorized for this goal):`,
      `- Explore unfamiliar code / multi-file review / parallel research → delegate to subagents (scout, reviewer) instead of reading everything inline.`,
      `- Independent parallel implementation lanes → workflow fan-out (worker lanes), one writer per lane (worktree if concurrent writes).`,
      `- Trivial single-file edits and orchestration decisions stay inline.`,
      `- Delegated child tokens are billed to this goal's budget (recorded at turn_end); child context stays out of this session, keeping your input growth slow — delegation is the budget-cheapest way to work.`,
    ].join("\n");
  }

  /** Build model-facing injection text for <untrusted_objective> block */
  buildInjection(): string | undefined {
    const g = goalState.current;
    if (!g || g.status === "complete") return undefined;
    const budgetLine = this.budgetBandGuidance();
    if (g.status === "active") {
      const parts = [
        `There is an active goal, with ${g.tokensUsed} tokens used, ${g.turnsUsed} turns taken.`,
        ``,
        `<untrusted_objective>`,
        g.objective,
        `</untrusted_objective>`,
      ];
      if (g.completionCriterion) parts.push(``, `Completion criterion: ${g.completionCriterion}`);
      const delegation = this.buildDelegationGuidance();
      if (delegation) parts.push(``, delegation);
      if (budgetLine) parts.push(``, budgetLine);
      return parts.join("\n");
    }
    if (g.status === "paused") {
      const parts = [`The goal is paused.\n\n<untrusted_objective>\n${g.objective}\n</untrusted_objective>`];
      if (budgetLine) parts.push(`\n${budgetLine}`);
      return parts.join("");
    }
    if (g.status === "blocked") {
      return `There is a goal, blocked${g.terminalReason ? ` (${g.terminalReason})` : ""}.\n\n<untrusted_objective>\n${g.objective}\n</untrusted_objective>`;
    }
    if (g.status === "budget_limited" || g.status === "usage_limited") {
      const wrapUp = this.buildWrapUpInjection();
      const parts = [
        `There is a goal, ${g.status === "budget_limited" ? "budget limited" : "usage limited"}${g.terminalReason ? ` (${g.terminalReason})` : ""}.`,
        ``,
        `<untrusted_objective>`,
        g.objective,
        `</untrusted_objective>`,
      ];
      if (wrapUp) parts.push(``, wrapUp);
      return parts.join("\n");
    }
    return undefined;
  }

  /**
   * Inject goal context into messages.
   * Called from context event handler.
   *
   * Cache-friendly (docs/research/client-injection-cache-optimization.md):
   * the injection (which carries tokensUsed/turnsUsed counters that change
   * EVERY turn) lands as a TAIL user message, never in the system prompt —
   * the CC `<total_tokens>` drift pattern invalidates the prefix cache for
   * the whole conversation on every turn. The message is ephemeral
   * (context-event deep copy), so it is not persisted into the session.
   */
  injectIntoMessages(messages: Array<{ role: string; content?: any; timestamp?: number }>): void {
    const injection = this.buildInjection();
    if (!injection) return;
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: injection }],
      timestamp: Date.now(),
    });
  }

  // ── Completion Statistics ─────────────────────────────────────────────

  /**
   * Format completion statistics for display.
   * Shows when goal completes.
   */
  formatCompletionStats(): string | undefined {
    const g = goalState.current;
    if (!g || g.status !== "complete") return undefined;

    const durationMs = g.wallClockMs;
    const durationMin = Math.round(durationMs / 60000);
    const durationSec = Math.round(durationMs / 1000);

    return [
      `✓ Goal completed: ${g.objective.slice(0, 60)}`,
      `  Turns: ${g.turnsUsed}`,
      `  Tokens: ${g.tokensUsed}`,
      `  Duration: ${durationMin > 0 ? `${durationMin}min` : `${durationSec}s`}`,
    ].join("\n");
  }

  // ── Persistence ────────────────────────────────────────────────────────

  /** Serialize to entry data for appendEntry persistence */
  toEntryData(): GoalSnapshot | null {
    return goalState.current;
  }

  /**
   * Restore from entry data.
   * Monotonic counters: when the in-memory goal is the same goalId, the
   * accounting counters never regress — a stale persisted entry must not
   * pull turnsUsed / tokensUsed / wallClockMs backwards (that regression is
   * what made the footer badge bounce between the newer in-memory value and
   * the older entry value). A different goalId (session switch) replaces
   * wholesale.
   */
  restoreFromData(data: GoalSnapshot): void {
    const cur = goalState.current;
    if (cur && cur.goalId === data.goalId) {
      const merged: GoalSnapshot = {
        ...data,
        turnsUsed: Math.max(cur.turnsUsed, data.turnsUsed ?? 0),
        tokensUsed: Math.max(cur.tokensUsed, data.tokensUsed ?? 0),
        wallClockMs: Math.max(cur.wallClockMs, data.wallClockMs ?? 0),
      };
      // B3: topUps is monotonic too — a stale entry must not reset the
      // user's remaining auto-renewal allowance. Only set when either side
      // ever recorded one (keeps snapshots without topUps field-clean).
      if (cur.topUps !== undefined || data.topUps !== undefined) {
        merged.topUps = Math.max(cur.topUps ?? 0, data.topUps ?? 0);
      }
      // 2026-10-26: autoRenewals is monotonic for the same reason.
      if (cur.autoRenewals !== undefined || data.autoRenewals !== undefined) {
        merged.autoRenewals = Math.max(cur.autoRenewals ?? 0, data.autoRenewals ?? 0);
      }
      setCurrentGoal(merged);
      return;
    }
    setCurrentGoal(data);
  }

  /**
   * Try to restore goal from session entries (handles host hot-reload).
   * Core takes plain entries — the host reads them from its session
   * manager and passes them in, keeping core free of session APIs.
   *
   * Restore-if-empty only: when an in-memory goal exists this is a no-op,
   * so it can never clobber newer live state with an older entry. When the
   * latest goal entry is a "complete" tombstone (goal completed or cleared),
   * there is nothing to restore — do NOT fall through to older entries.
   */
  tryRestoreFromEntries(entries: any[]): boolean {
    if (goalState.current) return true;
    try {
      if (!entries) return false;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as any;
        if (e.type === "custom" && e.customType === GOAL_ENTRY_TYPE && e.data) {
          // Tombstone: an ended goal is not restorable (complete
          // never rests on disk).
          if (e.data.status === "complete") return false;
          this.restoreFromData(e.data);
          return true;
        }
      }
    } catch { /* not critical */ }
    return false;
  }

  /** Reconstruct goal from session entries (normalization after replay) */
  reconstructFromEntries(entries: any[]): GoalSnapshot | null {
    const goal = reconstructGoalFromEntries(entries);
    if (goal) {
      setCurrentGoal(goal);
      this.persist();
    }
    return goal;
  }

  // ── Registration helpers ───────────────────────────────────────────────

  /** Register goal tools */
  registerTools(pi: any): void {
    registerGoalTools(pi, this);
  }

  /** Register goal commands */
  registerCommands(pi: any): void {
    registerGoalCommands(pi, this);
  }
}

export const goalManager = new GoalManager();
