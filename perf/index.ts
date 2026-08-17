// ============================================================
// Perf Lab — measurement layer for long-running optimization.
//
// Registers three tools: bench_run (remote benchmark, N-run stats,
// environment snapshot), profile_parse (torch profiler trace -> hotspot
// table), metric_compare (Mann-Whitney significance between two runs).
//
// Permission gating: these are ordinary pi tools, so every invocation is
// gated by the harness permission policy chain (destructive-command guard,
// sensitive-file guard, session approvals) before this code runs. The ssh
// subprocesses spawned here never bypass that chain — pi approves or blocks
// the tool_call itself, not the subprocess.
//
// Results persist to .perf/<run-id>.json (project-relative) so pi-multiloop's
// verify command can read them without coupling to this module.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { buildBenchScript, buildSshCommand, buildEnvSnapshotCmd } from "../packages/core/perf/remote";
import { parseTorchProfile } from "../packages/core/perf/parsers";
import { quantile, mad, filterOutliers, compareStats } from "../packages/core/perf/stats";
import type { BenchStats, CompareResult, ProfileReport, RunSpec } from "../packages/core/perf/types";

// ── ssh execution (injectable for tests) ─────────────────────

export type ExecResult = { stdout: string; stderr: string; code: number };
export type ExecSsh = (argv: string[]) => Promise<ExecResult>;

async function defaultExecSsh(argv: string[]): Promise<ExecResult> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.on("error", (err) => resolve({ stdout, stderr: String(err), code: 1 }));
  });
}

let execSshImpl: ExecSsh = defaultExecSsh;

/** Test injection point: replace the ssh executor; pass null to restore. */
export function __setExecForTest(fn: ExecSsh | null): void {
  execSshImpl = fn ?? defaultExecSsh;
}

function execSsh(argv: string[]): Promise<ExecResult> {
  return execSshImpl(argv);
}

// ── shared implementation (used by tools and *ForTest surfaces) ──

function collectValues(stdout: string): number[] {
  const out: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/PERF_VAL\s+([\d.]+)/);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

function sanitizeLabel(label: string | undefined): string {
  return (label ?? "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function formatBenchMarkdown(stats: BenchStats, snapshot: string, filePath: string): string {
  const envLine = snapshot ? snapshot.split("\n")[0] : "(unavailable)";
  return [
    "## bench_run",
    `- P50: ${stats.p50.toFixed(3)} · P95: ${stats.p95.toFixed(3)} · P99: ${stats.p99.toFixed(3)} (${stats.unit})`,
    `- MAD: ${stats.mad.toFixed(4)} · n=${stats.n} (outliers dropped: ${stats.outliersDropped})`,
    `- env: ${envLine}`,
    `- result file: ${filePath}`,
  ].join("\n");
}

function formatProfileMarkdown(report: ProfileReport): string {
  const rows = report.topN
    .map((e) => `| ${e.name} | ${e.selfUs.toFixed(1)} | ${e.selfPct.toFixed(1)}% | ${e.calls} | ${e.shape ?? ""} |`)
    .join("\n");
  return [
    `## profile: ${report.source}`,
    `total: ${report.totalUs.toFixed(1)} us`,
    "",
    "| op | self_us | self% | calls | shape |",
    "| --- | --- | --- | --- | --- |",
    rows,
  ].join("\n");
}

function formatCompareMarkdown(res: CompareResult): string {
  return [
    "## metric_compare",
    `- base: ${res.base} (P50 ${res.p50Base.toFixed(3)}) · cand: ${res.cand} (P50 ${res.p50Cand.toFixed(3)})`,
    `- delta: ${res.deltaPct.toFixed(1)}% · p=${res.p.toFixed(4)}${res.significant ? " (significant)" : " (not significant)"}`,
    `- verdict: ${res.verdict}`,
    `- advice: ${res.advice}`,
  ].join("\n");
}

export interface BenchRunOutcome {
  stats: BenchStats;
  snapshot: string;
  filePath: string;
  markdown: string;
}

async function runBench(spec: RunSpec): Promise<BenchRunOutcome> {
  const script = buildBenchScript(spec, spec.command);
  const run = await execSsh(buildSshCommand(spec.host, spec.workdir, script));
  const rawValues = collectValues(run.stdout);
  if (rawValues.length === 0) {
    throw new Error(
      `bench_run: no PERF_VAL lines in remote output (ssh code ${run.code}). stderr: ${run.stderr || "(none)"} stdout tail: ${run.stdout.slice(-200)}`
    );
  }
  const values = filterOutliers(rawValues);
  const stats: BenchStats = {
    runId: `bench-${Date.now()}`,
    label: spec.label,
    spec,
    values,
    unit: "ms",
    n: values.length,
    p50: quantile(values, 0.5) ?? 0,
    p95: quantile(values, 0.95) ?? 0,
    p99: quantile(values, 0.99) ?? 0,
    mad: mad(values),
    outliersDropped: rawValues.length - values.length,
    createdAt: new Date().toISOString(),
  };

  const snapRes = await execSsh(["ssh", spec.host, `bash -lc '${buildEnvSnapshotCmd()}'`]);
  const snapshot = snapRes.stdout.trim();

  const fileName = `${stats.runId}${sanitizeLabel(spec.label) ? "-" + sanitizeLabel(spec.label) : ""}.json`;
  const filePath = path.join(".perf", fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ stats, snapshot }, null, 2));

  return { stats, snapshot, filePath, markdown: formatBenchMarkdown(stats, snapshot, filePath) };
}

export interface ProfileOutcome {
  report: ProfileReport;
  filePath: string;
  markdown: string;
}

async function runProfile(host: string, tracePath: string, topN: number): Promise<ProfileOutcome> {
  const res = await execSsh(["ssh", host, `bash -lc 'cat ${tracePath}'`]);
  const parsed = JSON.parse(res.stdout) as { traceEvents?: unknown[] };
  const report = parseTorchProfile(parsed, topN, tracePath);
  const filePath = path.join(".perf", `profile-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return { report, filePath, markdown: formatProfileMarkdown(report) };
}

async function runCompare(fileA: string, fileB: string, direction: "lower" | "higher"): Promise<CompareResult> {
  const a = JSON.parse(fs.readFileSync(fileA, "utf8")) as { stats: BenchStats };
  const b = JSON.parse(fs.readFileSync(fileB, "utf8")) as { stats: BenchStats };
  return compareStats(
    { values: a.stats.values, label: a.stats.label ?? path.basename(fileA) },
    { values: b.stats.values, label: b.stats.label ?? path.basename(fileB) },
    { direction },
  );
}

// ── *ForTest surfaces (same implementation path as the tools) ──

export async function benchRunForTest(spec: RunSpec): Promise<BenchRunOutcome> {
  return runBench(spec);
}

export async function compareForTest(
  fileA: string,
  fileB: string,
  direction: "lower" | "higher",
): Promise<CompareResult> {
  return runCompare(fileA, fileB, direction);
}

export async function profileParseForTest(tracePath: string, topN: number, host = "mock"): Promise<ProfileOutcome> {
  return runProfile(host, tracePath, topN);
}

// ── tool registration ────────────────────────────────────────

export function registerPerfTools(pi: any): void {
  pi.registerTool({
    name: "bench_run",
    label: "Bench Run",
    promptSnippet: "bench_run: run a remote benchmark N times and summarize P50/P95/MAD stats with an environment snapshot",
    promptGuidelines: [
      "Use this to measure any remote benchmark reproducibly: it runs warmup + N measured iterations and reports P50/P95/P99/MAD instead of a single noisy number",
      "host is an ssh alias from ~/.ssh/config (e.g. kunshan-quant); workdir is the absolute remote working directory",
      "command should print one number per run; prefix the measured line with 'PERF_VAL ' (e.g. echo PERF_VAL 12.3) for reliable extraction",
      "Set runs (default 10) and warmup (default 2) high enough that MAD-based outlier rejection has signal",
      "The result file lands in .perf/ and can be fed to metric_compare or a pi-multiloop verify command",
    ],
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "ssh alias of the remote host (from ~/.ssh/config)" },
        workdir: { type: "string", description: "absolute working directory on the remote host" },
        command: { type: "string", description: "benchmark command; print one number per run, ideally prefixed 'PERF_VAL '" },
        runs: { type: "number", description: "measured iterations (default 10)" },
        warmup: { type: "number", description: "silent warmup iterations (default 2)" },
        env: { type: "object", description: "environment variables to export on the remote side" },
        label: { type: "string", description: "short label used in the result file name" },
      },
      required: ["host", "workdir", "command"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      const spec: RunSpec = {
        host: String(params?.host ?? ""),
        workdir: String(params?.workdir ?? ""),
        command: String(params?.command ?? ""),
        runs: Number(params?.runs ?? 10),
        warmup: Number(params?.warmup ?? 2),
        env: params?.env ?? undefined,
        label: params?.label ?? undefined,
      };
      try {
        const out = await runBench(spec);
        return { content: [{ type: "text", text: out.markdown, details: { filePath: out.filePath, stats: out.stats } }] };
      } catch (e) {
        return { content: [{ type: "text", text: `bench_run failed: ${String(e)}` }] };
      }
    },
  });

  pi.registerTool({
    name: "profile_parse",
    label: "Profile Parse",
    promptSnippet: "profile_parse: parse a remote torch.profiler chrome-trace JSON into a hotspot table",
    promptGuidelines: [
      "Use this to turn a torch.profiler export_chrome_trace JSON into an op/kernel hotspot table the model can reason about directly",
      "tracePath is the absolute path on the remote host (the file is fetched via ssh cat and parsed locally)",
      "topN limits the table to the hottest N aggregated ops (default 15)",
    ],
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "ssh alias of the remote host holding the trace file" },
        tracePath: { type: "string", description: "absolute path to the chrome-trace JSON on the remote host" },
        topN: { type: "number", description: "number of hottest ops to report (default 15)" },
      },
      required: ["host", "tracePath"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      try {
        const out = await runProfile(String(params?.host ?? ""), String(params?.tracePath ?? ""), Number(params?.topN ?? 15));
        return { content: [{ type: "text", text: out.markdown, details: { filePath: out.filePath, report: out.report } }] };
      } catch (e) {
        return { content: [{ type: "text", text: `profile_parse failed: ${String(e)}` }] };
      }
    },
  });

  pi.registerTool({
    name: "metric_compare",
    label: "Metric Compare",
    promptSnippet: "metric_compare: significance test between two .perf result files (improve/regress/noise)",
    promptGuidelines: [
      "Use this to decide whether a change actually moved the metric or the difference is benchmark noise",
      "fileA is the baseline result file and fileB the candidate (paths to .perf/*.json from bench_run)",
      "direction is 'lower' (latency, smaller is better — default) or 'higher' (throughput)",
      "Uses Mann-Whitney significance (p < 0.05) on MAD-filtered values; 'noise' means increase runs before deciding",
    ],
    parameters: {
      type: "object",
      properties: {
        fileA: { type: "string", description: "baseline result file path (.perf/*.json)" },
        fileB: { type: "string", description: "candidate result file path (.perf/*.json)" },
        direction: { type: "string", enum: ["lower", "higher"], description: "lower = smaller is better (default); higher = larger is better" },
      },
      required: ["fileA", "fileB"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      try {
        const direction = params?.direction === "higher" ? "higher" : "lower";
        const res = await runCompare(String(params?.fileA ?? ""), String(params?.fileB ?? ""), direction);
        return { content: [{ type: "text", text: formatCompareMarkdown(res), details: res }] };
      } catch (e) {
        return { content: [{ type: "text", text: `metric_compare failed: ${String(e)}` }] };
      }
    },
  });
}
