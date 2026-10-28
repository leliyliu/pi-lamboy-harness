// ============================================================
// Goal Types — lifecycle + Budget Report
// ============================================================

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'usage_limited' | 'budget_limited';
export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  tokenBudget?: number;
  turnBudget?: number;
  wallClockBudgetMs?: number;
}

/**
 * Friendly helper: convert a budget value + unit into GoalBudgetLimits.
 * Supports turns/tokens for count budgets and ms/s/minutes/hours for wall clock.
 */
export function parseBudgetToLimits(budget: number, unit: string): GoalBudgetLimits {
  switch (unit) {
    case "turns":
      return { turnBudget: budget };
    case "tokens":
      return { tokenBudget: budget };
    case "ms":
      return { wallClockBudgetMs: budget };
    case "s":
      return { wallClockBudgetMs: budget * 1000 };
    case "minutes":
      return { wallClockBudgetMs: budget * 60 * 1000 };
    case "hours":
      return { wallClockBudgetMs: budget * 60 * 60 * 1000 };
    default:
      return {};
  }
}

export interface GoalBudgetReport {
  tokenBudget: number | null;
  turnBudget: number | null;
  wallClockBudgetMs: number | null;
  remainingTokens: number | null;
  remainingTurns: number | null;
  remainingWallClockMs: number | null;
  tokenBudgetReached: boolean;
  turnBudgetReached: boolean;
  wallClockBudgetReached: boolean;
  overBudget: boolean;
}

export interface GoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  lastActor: GoalActor;
  lastActedAt: string; // ISO timestamp for audit
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  wallClockResumedAt?: number; // timestamp when goal became active
  budgetLimits?: GoalBudgetLimits;
  budget?: GoalBudgetReport;
  terminalReason?: string;
  completionSummary?: string;    // preserved after goal completion
  /** B3 (spec §3): auto top-ups used via /goal resume (user entry point only). */
  topUps?: number;
  /** 2026-10-26 auto-renew: token-budget extensions applied by the runtime
   *  when the goal runs out (independent of topUps). */
  autoRenewals?: number;
  /** B4 (spec §3): auto-extend the token budget on exhaustion (create_goal
   *  param, default false). When true, crossing tokenBudget steps the budget
   *  up instead of entering budget_limited (same top-up cap as B3). When the
   *  top-up cap is exhausted, the runtime auto-renew policy (2026-10-26)
   *  takes over — see autoRenewals. */
  autoExtend?: boolean;
  /** Queue position if goal is part of a queue */
  queueIndex?: number;
}

// Goal Queue types
export interface GoalQueueItem {
  id: string;
  objective: string;
  completionCriterion?: string;
  budgetLimits?: GoalBudgetLimits;
  status: "pending" | "active" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  /**
   * P0 (4): priority recorded at enqueue time so a real priority queue can be
   * maintained by insertion. Optional for backward compatibility with any items
   * created before this field existed (defaults to "normal").
   */
  priority?: "high" | "normal" | "low";
}

export interface GoalQueue {
  items: GoalQueueItem[];
  currentIndex: number;
  mode: "fifo" | "priority";
}

/**
 * Runtime auto-renewal record (recordTurn / recordTokenUsage).
 * `reason` distinguishes the two policies: "headroom" is the 2026-10-28
 * pre-exhaustion top-up (budget raised at the warn tier), "crossing" is the
 * 2026-10-26 renewal fired exactly at the limit.
 */
export interface AutoRenewInfo {
  budget: number;
  count: number;
  reason?: "headroom" | "crossing";
}

// Entry type for persistence
export const GOAL_ENTRY_TYPE = "lamboy_goal";

/**
 * B2 (spec §3): tools always allowed while budget_limited / usage_limited.
 * Single source shared by the wrap-up text, shouldBlockTool and the
 * tool_call gate reason (extensions/40-goal.ts) — a drift in any one of
 * them re-creates the B1 failure mode (the exhausted turn must always be
 * able to park the handoff briefing). Review nit 5, 2026-10-19.
 */
export const GOAL_LIMITED_ALLOWED_TOOLS: readonly string[] = ["get_goal", "handoff", "update_goal"];
/** Human-readable form for injection/reason strings (same set, in speech order). */
export const GOAL_LIMITED_ALLOWED_TOOLS_LABEL = "get_goal, handoff, update_goal";

export interface GoalEntryData {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  lastActor: GoalActor;
  lastActedAt: string;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  wallClockResumedAt?: number;
  budgetLimits?: GoalBudgetLimits;
  terminalReason?: string;
  /** B3 (spec §3): auto top-ups used via /goal resume. */
  topUps?: number;
  /** 2026-10-26: runtime auto-renewal count (independent of topUps). */
  autoRenewals?: number;
  /** B4 (spec §3): create_goal autoExtend flag (default false). */
  autoExtend?: boolean;
}

// Global state
//
// NOTE: `export const` containers + property-level mutation, never reassigned
// `export let` bindings — pi's jiti loader (2.7.0) snapshots cross-module
// `export let` state, so writes would be invisible to other modules. Mutating
// properties of a shared container keeps every importer on the same live object.
export const goalState: { current: GoalSnapshot | null } = { current: null };
export function setCurrentGoal(g: GoalSnapshot | null): void { goalState.current = g; }

export const goalQueueState: GoalQueue = { items: [], currentIndex: 0, mode: "fifo" };
export function setCurrentQueue(q: GoalQueue): void {
  goalQueueState.items = q.items;
  goalQueueState.currentIndex = q.currentIndex;
  goalQueueState.mode = q.mode;
}
