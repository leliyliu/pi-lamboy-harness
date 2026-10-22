// ============================================================
// Goal System — lifecycle + persistence + injection
// ============================================================

import type { GoalSnapshot, GoalStatus, GoalActor, GoalBudgetLimits } from "./types.ts";
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
  recordTurn(tokens: number, actor: GoalActor = "runtime"): { crossedBudget: boolean; autoExtendedTo?: number } {
    const g = goalState.current;
    if (!g || g.status !== "active") return { crossedBudget: false };

    const now = Date.now();
    const deltaMs = g.wallClockResumedAt ? Math.max(0, now - g.wallClockResumedAt) : 0;

    const newTokens = g.tokensUsed + tokens;
    const newTurns = g.turnsUsed + 1;
    const newWallClockMs = g.wallClockMs + deltaMs;

    // Check all three budget types
    const limits = g.budgetLimits ?? {};
    const crossedTokens = limits.tokenBudget !== undefined && limits.tokenBudget > 0 && newTokens >= limits.tokenBudget;
    const crossedTurns = limits.turnBudget !== undefined && limits.turnBudget > 0 && newTurns >= limits.turnBudget;
    const crossedWallClock = limits.wallClockBudgetMs !== undefined && limits.wallClockBudgetMs > 0 && newWallClockMs >= limits.wallClockBudgetMs;

    const crossed = crossedTokens || crossedTurns || crossedWallClock;
    let newStatus: GoalStatus = g.status;
    let terminalReason = crossed ? "Budget exceeded" : g.terminalReason;
    let autoExtendedTo: number | undefined;
    let newLimits = limits;
    let topUps = g.topUps;

    if (crossed) {
      const max = this.topUpMax();
      const underCap = max === 0 || (g.topUps ?? 0) < max;
      // B4: a token crossing on an autoExtend goal is excused by extending the
      // budget — but only when nothing else stops the goal. Finding 2 fix
      // (review 2026-10-19): decide the stop FIRST; a simultaneous
      // turn/wall-clock crossing must not consume a top-up (the goal stops
      // anyway — extending would be dead weight, and would misreport a
      // token-crossing goal as "blocked" instead of budget_limited).
      const tokenExcusable = crossedTokens && g.autoExtend === true && underCap;
      const stillCrossed = (crossedTurns || crossedWallClock) || (crossedTokens && !tokenExcusable);
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
      }
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
    }, actor)));
    this.persist();
    // crossedBudget = the goal actually stopped (autoExtend alone doesn't stop).
    const stopped = newStatus !== "active";
    return { crossedBudget: stopped, autoExtendedTo };
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
  recordTokenUsage(delta: number): { crossedBudget: boolean; autoExtendedTo?: number } {
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
    const limits = g.budgetLimits ?? {};
    const crossedTokens = limits.tokenBudget !== undefined && limits.tokenBudget > 0 && newTokens >= limits.tokenBudget;

    let autoExtendedTo: number | undefined;
    let newLimits = limits;
    let topUps = g.topUps;
    let status: GoalStatus | undefined;
    let terminalReason: string | undefined;

    if (accumulating && crossedTokens) {
      const max = this.topUpMax();
      const underCap = max === 0 || (g.topUps ?? 0) < max;
      if (g.autoExtend && underCap) {
        const step = this.extendStep();
        autoExtendedTo = (limits.tokenBudget ?? 0) + step;
        newLimits = { ...limits, tokenBudget: autoExtendedTo };
        topUps = (g.topUps ?? 0) + 1;
      } else {
        status = "budget_limited";
        terminalReason = "Budget exceeded";
      }
    }

    setCurrentGoal(cloneSnapshot(g, {
      tokensUsed: newTokens,
      ...(status !== undefined ? { status, terminalReason } : {}),
      // Nit 8 (review): budgetLimits only when an extension changed it.
      ...(autoExtendedTo !== undefined ? { budgetLimits: newLimits } : {}),
      ...(topUps !== g.topUps ? { topUps } : {}),
    }));
    if (this.persistFn) this.persistFn(goalState.current);
    // crossedBudget = this call actually flipped/kept the goal stopped by
    // tokens (not: merely accumulated over an already-limited budget).
    return { crossedBudget: status === "budget_limited", autoExtendedTo };
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
   */
  private extendStep(): number {
    const raw = process.env.PI_LAMBOY_GOAL_EXTEND_STEP;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n > 0 ? n : 500000;
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
   * B1 (spec §3): wrap-up for budget_limited — the exhausted turn MUST first
   * park a handoff briefing (the handoff tool is whitelisted in
   * shouldBlockTool and the tool_call gate), so the user can continue via
   * /handoff in one keystroke. The draft flow already exists in 85-handoff.ts
   * (HANDOFF_DRAFT_TYPE entry → turn_end editor prefill → /handoff review).
   *
   * Wording style: explicit whitelist + immediate actionable instruction — the
   * pattern validated by the usage_limited fix (quant02 2026-09-16); the old
   * "You MUST NOT use any tools" blanket ban also suppressed the handoff tool,
   * which is exactly why an exhausted goal could not hand off.
   */
  private buildBudgetLimitedWrapUp(statusLabel: string): string {
    return [
      `⚠️ ${statusLabel}. Allowed tools right now: ${GOAL_LIMITED_ALLOWED_TOOLS_LABEL} (nothing else).`,
      ``,
      `1. Call the handoff tool NOW with a complete self-contained briefing:`,
      `   - context & decisions so far`,
      `   - files involved (paths)`,
      `   - the goal's objective & completion criterion, remaining work, suggested next budget`,
      `   The briefing is the only thing the next session sees.`,
      `2. Then give a 2-3 line wrap-up. Do NOT continue goal work inline.`,
      ``,
      `The user continues via /handoff (one keystroke) — the draft you write now is what they get.`,
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
   * budget_limited (user tokenBudget) now instructs the model to write the
   * handoff briefing first (B1, spec §3) — renewal stays reserved for the
   * user: /goal resume auto-tops-up (B3), set_goal_budget raises explicitly.
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
