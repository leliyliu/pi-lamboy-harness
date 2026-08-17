// perf-lab core types — pure, no host imports.
export interface RunSpec {
  host: string; workdir: string; command: string;
  runs: number; warmup: number; env?: Record<string, string>;
  parser?: "auto" | "json-report" | "stdout-number";
}
export interface BenchStats {
  runId: string; label?: string; spec: RunSpec;
  values: number[]; unit: string;
  n: number; p50: number; p95: number; p99: number; mad: number;
  outliersDropped: number; createdAt: string;
}
export interface ProfileReport {
  runId: string; source: string; topN: ProfileEntry[]; totalUs: number; extractedAt: string;
}
export interface ProfileEntry {
  name: string; selfUs: number; selfPct: number; calls: number; shape?: string;
}
export interface CompareResult {
  base: string; cand: string; unit: string;
  p50Base: number; p50Cand: number; deltaPct: number;
  p: number; significant: boolean; verdict: "improve" | "regress" | "noise";
  advice: string;
}
