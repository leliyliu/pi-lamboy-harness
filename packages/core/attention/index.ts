// ============================================================
// Attention — cross-extension "the user is now blocked on a dialog"
// signal.
//
// Repo code (ask tool, permission approvals, plan review) calls
// emitAttention() right before it opens a blocking dialog. A host
// extension — personal/extensions/notify.ts in this setup — subscribes to
// ATTENTION_CHANNEL on pi.events and raises an OS-level popup + sound, so
// the user notices the prompt even when the terminal is in the background.
//
// Transport: pi.events (the documented cross-extension EventBus). Two
// reasons it is not a module-level registry:
//   - pi loads every extension entry through its own jiti instance with
//     moduleCache disabled (loader.js), so repo core modules imported by two
//     different extension entries are distinct module instances;
//   - the EventBus is process-wide and its handlers are wrapped in
//     try/catch, which gives fail-open delivery for free.
//
// Each extension entry that emits binds the bus once (setAttentionBus);
// the binding is module-local *within that entry's bundle*, which is exactly
// the scope its emits live in.
//
// Invariants:
//   1. Default is a no-op — the public harness never imposes desktop
//      notifications on other platforms/users.
//   2. Fail-open — bus errors are swallowed; a notification must never block
//      or change an approval/question decision.
// ============================================================

/** Process-wide channel subscribed by the host notifier extension. */
export const ATTENTION_CHANNEL = "lamboy:attention";

/** Same-kind events inside this window are treated as one disturbance. */
export const ATTENTION_DEDUPE_MS = 800;

/** Which blocking dialog is waiting for the user. */
export type AttentionKind = "ask" | "approval" | "plan";

export interface AttentionRequest {
  kind: AttentionKind;
  title: string;
  body: string;
  /**
   * Host mode from the pi ctx (e.g. "tui" | "rpc"). Only "tui" (or an
   * omitted mode, for callers without a ctx) is delivered — headless/RPC
   * hosts and pipes must stay silent.
   */
  mode?: string;
}

/** Minimal EventBus surface (subset of pi's EventBus). */
export interface AttentionBus {
  emit(channel: string, data: unknown): void;
}

const lastByKind: Partial<Record<AttentionKind, number>> = {};
let bus: AttentionBus | null = null;

/** Bind the extension's pi.events bus (null clears it). */
export function setAttentionBus(next: AttentionBus | null): void {
  bus = next ?? null;
}

/**
 * Emit an attention event. Returns true when the event was handed to the bus,
 * false when skipped (no bus, non-TUI mode, or same-kind dedupe).
 */
export function emitAttention(req: AttentionRequest): boolean {
  try {
    // Non-interactive hosts must never pop a desktop notification.
    if (req.mode !== undefined && req.mode !== "tui") return false;
    if (!bus) return false;

    const now = Date.now();
    const last = lastByKind[req.kind];
    if (last !== undefined && now - last < ATTENTION_DEDUPE_MS) return false;

    // Record before dispatching: a throwing/duplicate handler must not turn a
    // tight retry loop into spam (spam protection is independent of delivery).
    lastByKind[req.kind] = now;
    bus.emit(ATTENTION_CHANNEL, { ...req });
    return true;
  } catch {
    // fail-open: notification problems never reach the dialog flow
    return false;
  }
}

/** Test seam: forget dedupe timestamps and drop the bus binding. */
export function resetAttentionState(): void {
  for (const kind of Object.keys(lastByKind) as AttentionKind[]) delete lastByKind[kind];
  bus = null;
}
