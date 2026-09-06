// ============================================================
// Extension entry: Perf lab — bench_run (remote GPU benchmark,
// N-run stats + env snapshot), profile_parse (torch profiler trace
// → hotspot table), metric_compare (Mann-Whitney significance).
// Results persist to .perf/<run-id>.json for pi-multiloop verify
// commands.
//
// Filter out this file to drop the performance tooling (e.g. when
// working on non-GPU projects where the tools would only add
// context weight).
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPerfTools } from "../perf/index";

export default function (pi: ExtensionAPI) {
  registerPerfTools(pi);
}
