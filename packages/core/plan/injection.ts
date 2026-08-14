// ============================================================
// Plan Injection — Context injection for plan mode
//
// NOTE: This module is kept for backward compatibility. The
// canonical implementation lives on PlanManager.buildInjection()
// / injectIntoMessages() in ./index.ts (aligned
// wording). These helpers simply delegate to it.
// ============================================================

import type { PlanManager } from "./index.ts";

/**
 * Build plan mode injection for system prompt.
 * Delegates to PlanManager.buildInjection().
 */
export function buildPlanModeInjection(planManager: PlanManager): string | undefined {
  return planManager.buildInjection(false);
}

/**
 * Inject plan mode into system prompt messages.
 * Delegates to PlanManager.injectIntoMessages().
 */
export function injectPlanMode(
  planManager: PlanManager,
  messages: Array<{ role: string; content?: any }>
): void {
  planManager.injectIntoMessages(messages);
}
