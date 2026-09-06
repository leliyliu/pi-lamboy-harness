// ============================================================
// Extension entry: TUI — boxed/compact editor chrome, /tui command
// (style / shimmer / timing), border spinner + working message,
// and the plan-mode badge on the editor's top border.
//
// The badge provider reads planManager state directly; if the plan
// entry (20-plan.ts) is filtered out, planManager stays inactive and
// the badge simply never shows — no coupling needed.
//
// Filter out this file to keep pi's default editor chrome.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planManager } from "../packages/core/plan";
import { registerTui, setTuiBadgeProvider } from "../tui/index";

export default function (pi: ExtensionAPI) {
  try { registerTui(pi); } catch { /* TUI chrome must never break extension load */ }

  // Plan-mode badge on the editor's top border (lazy, cheap in-memory
  // check; reads planManager's state without coupling tui → plan).
  try {
    setTuiBadgeProvider(() => (planManager.isPlanModeActive() ? " plan " : undefined));
  } catch { /* badge is cosmetic */ }
}
