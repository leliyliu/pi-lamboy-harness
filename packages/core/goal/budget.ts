// ============================================================
// Goal Budget — Report computation + Prompt injection
// ============================================================

import type { GoalSnapshot, GoalBudgetReport, GoalBudgetLimits, GoalStatus } from "./types.ts";

/**
 * Live active-pursuit time: the accumulated total plus the in-flight active interval.
 * Correct even when read mid-turn (the interval isn't folded into wallClockMs until the goal leaves active).
 */
export function liveWallClockMs(state: GoalSnapshot, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

/**
 * Compute budget report for a goal.
 * Returns remaining amounts and whether each budget is reached.
 */
export function computeBudgetReport(state: GoalSnapshot, now: number = Date.now()): GoalBudgetReport {
  const limits = state.budgetLimits ?? {};
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached = wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs: wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

/**
 * Format budget report as a human-readable string for prompt injection.
 */
export function formatBudgetReport(report: GoalBudgetReport): string {
  const parts: string[] = [];

  if (report.tokenBudget !== null) {
    const used = report.tokenBudget - (report.remainingTokens ?? 0);
    const pct = report.tokenBudget > 0 ? Math.round((used / report.tokenBudget) * 100) : 0;
    parts.push(`↑${used}/${report.tokenBudget} (${pct}% used, ${report.remainingTokens} remaining)`);
  }

  if (report.turnBudget !== null) {
    const used = report.turnBudget - (report.remainingTurns ?? 0);
    parts.push(`Turns: ${used}/${report.turnBudget} (${report.remainingTurns} remaining)`);
  }

  if (report.wallClockBudgetMs !== null) {
    const usedMs = report.wallClockBudgetMs - (report.remainingWallClockMs ?? 0);
    const usedMin = Math.round(usedMs / 60000);
    const totalMin = Math.round(report.wallClockBudgetMs / 60000);
    const remainMin = Math.round((report.remainingWallClockMs ?? 0) / 60000);
    parts.push(`Time: ${usedMin}min/${totalMin}min (${remainMin}min remaining)`);
  }

  if (parts.length === 0) return "";
  return `Budget: ${parts.join(" | ")}`;
}

/**
 * Budget guidance string for prompt injection.
 * Returns undefined if no budget limits are set.
 */
export function budgetBandGuidance(goal: GoalSnapshot | null): string | undefined {
  if (!goal || goal.status === "complete") return undefined;
  const report = computeBudgetReport(goal);
  const formatted = formatBudgetReport(report);
  if (!formatted) return undefined;
  // A3 (spec §2): tier lines on top of the numeric budget line. They give the
  // model a concrete protocol BEFORE exhaustion — 80%: prefer delegation (and
  // ask to raise if legitimate); 95%: park the handoff briefing NOW so the
  // user can continue in one keystroke even if the very next turn overflows.
  // Thresholds via PI_LAMBOY_GOAL_BUDGET_WARN / _CRIT (percent, 0 disables).
  const tier = budgetTierLine(report, goal.status);
  return tier ? `${formatted}\n${tier}` : formatted;
}

/** Read an integer percent threshold env (fallback default; 0 = off). */
function readTierEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

/**
 * A3 tier protocol line (spec §2). Returns undefined when no token budget,
 * not an operating state, below warn threshold, or the tier is disabled.
 */
export function budgetTierLine(
  report: GoalBudgetReport,
  status: GoalStatus | undefined,
): string | undefined {
  if (report.tokenBudget === null || report.tokenBudget <= 0) return undefined;
  if (status !== "active") return undefined; // tiers are pre-exhaustion guidance

  const warnPct = readTierEnv("PI_LAMBOY_GOAL_BUDGET_WARN", 80);
  const critPct = readTierEnv("PI_LAMBOY_GOAL_BUDGET_CRIT", 95);
  const usedPct = (report.tokenBudget - (report.remainingTokens ?? 0)) / report.tokenBudget * 100;

  if (critPct > 0 && usedPct >= critPct) {
    return `Budget ≥${critPct}%: call the handoff tool NOW with a complete self-contained briefing (context, decisions, files, next task) so the user can continue via /handoff in one keystroke. Then keep working only if the user raises the budget.`;
  }
  if (warnPct > 0 && usedPct >= warnPct) {
    return `Budget ≥${warnPct}%: prefer delegation over inline work; if the goal legitimately needs more, ask the user to raise via set_goal_budget.`;
  }
  return undefined;
}

// ============================================================
// Token budget policy (2026-09-29 user directive: "预算不能这么小")
// ============================================================

/** Default tokenBudget applied when create_goal omits it (env 0 disables). */
const DEFAULT_TOKEN_BUDGET = 800000;
/** Floor for passed tokenBudget values (env 0 disables raising). */
const MIN_TOKEN_BUDGET = 500000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface TokenBudgetPolicyResult {
  limits: GoalBudgetLimits;
  /** True when the default tokenBudget was injected (caller omitted it). */
  defaulted: boolean;
  /** True when a passed tokenBudget was raised to the floor. */
  raised: boolean;
  /** Effective tokenBudget after the policy (0 when none applies). */
  appliedTokenBudget: number;
}

/**
 * Tool-layer token budget policy — model path only (create_goal /
 * set_goal_budget execute). Core createGoal() and user-side /goal commands
 * pass caller limits through verbatim: the user is the final authority.
 *
 * - applyDefault: create_goal fills an omitted tokenBudget with the default
 *   (PI_LAMBOY_GOAL_TOKEN_BUDGET, fallback 800000). set_goal_budget passes
 *   false — setting a turns/ms budget must not silently add a token budget.
 * - Floor: values below PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET (fallback 500000,
 *   0 disables) are raised, so the model can never squeeze a goal into a
 *   tiny token budget.
 */
export function enforceTokenBudgetPolicy(
  limits: GoalBudgetLimits | undefined,
  opts: { applyDefault: boolean },
): TokenBudgetPolicyResult {
  const def = readEnvInt("PI_LAMBOY_GOAL_TOKEN_BUDGET", DEFAULT_TOKEN_BUDGET);
  const min = readEnvInt("PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET", MIN_TOKEN_BUDGET);
  const out: GoalBudgetLimits = { ...(limits ?? {}) };

  let defaulted = false;
  let raised = false;

  if (opts.applyDefault && def > 0 && out.tokenBudget === undefined) {
    out.tokenBudget = def;
    defaulted = true;
  }
  if (out.tokenBudget !== undefined && min > 0 && out.tokenBudget < min) {
    out.tokenBudget = min;
    raised = true;
  }

  return { limits: out, defaulted, raised, appliedTokenBudget: out.tokenBudget ?? 0 };
}
