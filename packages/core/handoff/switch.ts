// ============================================================
// Handoff → replacement session delivery (C5, 2026-10-28).
//
// The 2026-10-26 handoff flow renewed the goal budget but still only
// prefilled the new session's editor: the user had to press Enter before any
// work resumed ("handoff 之后还要我催"). The briefing was already reviewed and
// edited in the editor before the switch, so the replacement session can
// start on it directly.
//
// Kept in a pi-free module so the behavior is unit-testable with a stub ctx
// (importing handoff/commands.ts pulls in the pi TUI package).
// ============================================================

export interface HandoffTargetSession {
  sendUserMessage(content: string): Promise<void>;
  ui: { setEditorText(text: string): void };
}

/** PI_LAMBOY_HANDOFF_AUTOSUBMIT=0 restores the old "prefill and wait" mode. */
export function handoffAutoSubmitEnabled(): boolean {
  return process.env.PI_LAMBOY_HANDOFF_AUTOSUBMIT !== "0";
}

/**
 * Deliver the reviewed briefing to the new session.
 * Returns true when it was submitted as the first user message (the session
 * continues by itself), false when it was only prefilled for the user.
 * A sendUserMessage failure never loses the briefing: it falls back to the
 * editor prefill.
 */
export async function deliverHandoffBriefing(
  target: HandoffTargetSession,
  briefing: string,
): Promise<boolean> {
  if (handoffAutoSubmitEnabled()) {
    try {
      await target.sendUserMessage(briefing);
      return true;
    } catch { /* fall through to the editor prefill */ }
  }
  target.ui.setEditorText(briefing);
  return false;
}
