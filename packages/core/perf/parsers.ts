// perf-lab parsers — pure logic, no host imports.
// parseTorchProfile: chrome-trace JSON (torch.profiler export_chrome_trace)
//   -> aggregated hotspot table.
// extractBenchValue: benchmark stdout -> { value, unit } | null.

import type { ProfileReport, ProfileEntry } from "./types";

const KERNEL_CATS = new Set(["kernel", "cpu_op", "gpu_memcpy"]);

function fmtShape(dims: unknown): string | undefined {
  if (!Array.isArray(dims)) return undefined;
  if (dims.length !== 2) return undefined;
  const left = dims[0];
  const right = dims[1];
  if (!Array.isArray(left) || !Array.isArray(right)) return undefined;
  return `${left.join("x")} @ ${right.join("x")}`;
}

/**
 * Aggregate chrome-trace X events into a hotspot table.
 * Only events with ph === "X" and cat in {kernel, cpu_op, gpu_memcpy}
 * are considered; everything else (metadata "M", etc.) is ignored.
 * Events are aggregated by `name`: selfUs accumulates `dur`, calls counts
 * occurrences. Input Dims ([[m,k],[k,n]]) becomes "mxk @ kxn" when present.
 */
export function parseTorchProfile(
  trace: { traceEvents?: unknown[] },
  topN: number,
  source = "<memory>",
): ProfileReport {
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const agg = new Map<string, { selfUs: number; calls: number; shape?: string }>();

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    if (e.ph !== "X") continue;
    if (typeof e.cat !== "string" || !KERNEL_CATS.has(e.cat)) continue;
    if (typeof e.name !== "string") continue;
    const dur = typeof e.dur === "number" ? e.dur : 0;

    const cur = agg.get(e.name) ?? { selfUs: 0, calls: 0, shape: undefined as string | undefined };
    cur.selfUs += dur;
    cur.calls += 1;

    const args = (e.args ?? {}) as Record<string, unknown>;
    const dims = args["Input Dims"];
    if (cur.shape === undefined) {
      const s = fmtShape(dims);
      if (s !== undefined) cur.shape = s;
    }
    agg.set(e.name, cur);
  }

  const entries: ProfileEntry[] = [...agg.entries()]
    .map(([name, v]) => ({
      name,
      selfUs: v.selfUs,
      selfPct: 0,
      calls: v.calls,
      ...(v.shape !== undefined ? { shape: v.shape } : {}),
    }))
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, topN);

  const totalUs = [...agg.values()].reduce((s, v) => s + v.selfUs, 0);
  for (const e of entries) {
    e.selfPct = totalUs > 0 ? (e.selfUs / totalUs) * 100 : 0;
  }

  return {
    runId: "",
    source,
    topN: entries,
    totalUs,
    extractedAt: new Date().toISOString(),
  };
}

const UNIT_RE = "(ms|us|µs|s)";
const MEAN_RE = new RegExp(`mean\\s*[=:]\\s*([\\d.]+)\\s*${UNIT_RE}?`, "i");
const BARE_RE = new RegExp(`^([\\d.]+)\\s*${UNIT_RE}?$`);

/**
 * Extract a benchmark value from stdout.
 * Priority: explicit "mean = X [unit]" / "mean: X [unit]" first; otherwise
 * the last non-empty line matched as a bare number. Returns null when no
 * numeric measurement is found. Default unit is "ms".
 */
export function extractBenchValue(stdout: string): { value: number; unit: string } | null {
  if (typeof stdout !== "string" || stdout.trim() === "") return null;

  const mMean = stdout.match(MEAN_RE);
  if (mMean) {
    return { value: Number(mMean[1]), unit: mMean[2] ?? "ms" };
  }

  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    const m = line.match(BARE_RE);
    if (m) return { value: Number(m[1]), unit: m[2] ?? "ms" };
    // A non-matching non-empty line means the tail is prose, not numbers.
    break;
  }

  return null;
}
