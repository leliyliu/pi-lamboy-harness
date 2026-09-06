// ============================================================
// Extension entry: Truncation — spill oversized tool results to
// disk (toolResultTruncation pattern). A runaway log must not eat
// the context window; the full text lands in
// <sessionDir>/tool-results/ and the model gets a sanitized
// head+tail preview + output_path with paging instructions.
//
// Threshold is window-aware (issue #2): 1M-context models keep more
// tool output in-context instead of forcing a read round-trip.
// PI_TRUNCATION_THRESHOLD (chars) overrides everything.
//
// Filter out this file to disable the spill (pi's native truncation
// still applies).
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shouldTruncate, truncationPathFor, buildTruncatedPreview, truncationThresholdFor } from "../packages/core/truncation/index";

export default function (pi: ExtensionAPI) {
  // ── tool_result: spill oversized outputs to disk ──
  pi.on("tool_result", (event: any, ctx: any) => {
    try {
      const content = event?.content;
      if (!Array.isArray(content)) return undefined;
      let changed = false;
      // Window-aware spill threshold (issue #2): 1M-context models keep
      // more tool output in-context instead of forcing a read round-trip.
      const truncationThreshold = truncationThresholdFor(ctx?.model?.contextWindow);
      const out = content.map((part: any) => {
        if (part?.type !== "text" || typeof part.text !== "string" || !shouldTruncate(part.text, truncationThreshold)) return part;
        let base: string;
        try { base = ctx?.sessionManager?.getSessionDir?.() || path.join(os.tmpdir(), "pi-lamboy-harness"); }
        catch { base = path.join(os.tmpdir(), "pi-lamboy-harness"); }
        const p = truncationPathFor(base, String(event.toolName ?? "tool"), String(event.toolCallId ?? Date.now()));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, part.text, "utf8");
        changed = true;
        return { ...part, text: buildTruncatedPreview(part.text, p) };
      });
      if (changed) return { content: out };
    } catch { /* never break tool results */ }
    return undefined;
  });
}
