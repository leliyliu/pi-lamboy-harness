// ============================================================
// Handoff Guard — context-usage guard config + session-entry
// state helpers (pure, no pi runtime imports).
//
// The guard fires once per session at turn_end when context usage
// crosses the threshold, and can be suppressed for the session
// (persisted as a custom entry, restored on session_start / reload).
// Agent-authored handoff drafts are likewise custom entries — they
// do NOT participate in LLM context (pi.appendEntry semantics).
// ============================================================

/** Custom entry type storing an agent-authored handoff draft. */
export const HANDOFF_DRAFT_TYPE = "lamboy:handoff-draft";

/** Custom entry type storing guard suppression state. */
export const HANDOFF_GUARD_STATE_TYPE = "lamboy:handoff-guard-state";

export interface HandoffGuardConfig {
  enabled: boolean;
  /** Context-usage percent that triggers the guard (10–100). */
  thresholdPercent: number;
}

export const DEFAULT_GUARD_THRESHOLD_PERCENT = 90;

/**
 * Guard config from environment:
 *   PI_LAMBOY_HANDOFF=0          → whole extension disabled
 *   PI_LAMBOY_HANDOFF_GUARD=0    → guard only disabled
 *   PI_LAMBOY_HANDOFF_THRESHOLD  → trigger percent (clamped 10–100)
 */
export function guardConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): HandoffGuardConfig {
  const disabled =
    env.PI_LAMBOY_HANDOFF === "0" || env.PI_LAMBOY_HANDOFF_GUARD === "0";
  const raw = Number.parseInt(env.PI_LAMBOY_HANDOFF_THRESHOLD ?? "", 10);
  const threshold =
    Number.isFinite(raw) && raw >= 10 && raw <= 100 ? raw : DEFAULT_GUARD_THRESHOLD_PERCENT;
  return { enabled: !disabled, thresholdPercent: threshold };
}

// ---------------------------------------------------------------------------
// Draft entries (agent-authored via the handoff tool)
// ---------------------------------------------------------------------------

export interface HandoffDraft {
  prompt: string;
  /** ISO timestamp of when the draft was written. */
  createdAt?: string;
}

export function isHandoffDraft(value: unknown): value is HandoffDraft {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Partial<HandoffDraft>).prompt === "string";
}

export interface LatestDraft {
  prompt: string;
  /**
   * false once new conversation messages followed the draft — a stale
   * draft must not shadow regeneration.
   */
  fresh: boolean;
}

/**
 * Latest handoff draft in the branch. Freshness: no "message" entries
 * after the draft's position (the agent's tool result and custom entries
 * don't count — only actual conversation turns).
 */
export function latestHandoffDraft(
  branch: Array<{ type: string; customType?: string; data?: unknown }>,
): LatestDraft | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== HANDOFF_DRAFT_TYPE) continue;
    if (!isHandoffDraft(entry.data)) return null;
    let fresh = true;
    for (let j = i + 1; j < branch.length; j++) {
      if (branch[j].type === "message") {
        fresh = false;
        break;
      }
    }
    return { prompt: entry.data.prompt, fresh };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guard suppression state
// ---------------------------------------------------------------------------

export interface HandoffGuardState {
  suppressed: boolean;
  reason: "declined" | "dismissed";
}

export function isGuardSuppressed(
  branch: Array<{ type: string; customType?: string; data?: unknown }>,
): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== HANDOFF_GUARD_STATE_TYPE) continue;
    const data = entry.data as Partial<HandoffGuardState> | undefined;
    return data?.suppressed === true;
  }
  return false;
}
