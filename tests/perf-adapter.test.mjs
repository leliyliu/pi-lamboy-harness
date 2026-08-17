// perf-lab adapter tests — mock-ssh full-path coverage, no pi runtime needed.
// Covers: bench_run (collect PERF_VAL lines -> stats -> env snapshot -> .perf
// persistence -> markdown), metric_compare (two persisted files -> verdict),
// profile_parse (remote cat -> torch profile parse -> markdown table).
// Uses the jiti CJS loader; runs in its own process with cwd swapped to a
// tempdir so .perf/ writes are isolated.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { jitiUrl } from "./jiti-path.mjs";
const { createJiti } = await import(jitiUrl());
const jiti = createJiti(import.meta.url ?? __filename, { moduleCache: false });
const nativeRequire = createRequire(import.meta.url);
const moduleCache = new Map();

function resolveSpec(spec, parentFile) {
  if (!spec.startsWith(".")) return { native: spec };
  const clean = spec.endsWith(".js") ? spec.slice(0, -3) : spec; // TS ESM convention: ./x.js → ./x.ts
  const base = path.resolve(path.dirname(parentFile), clean);
  for (const c of [base + ".ts", base + ".js", base]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c };
  }
  throw new Error(`Cannot resolve ${spec} from ${parentFile}`);
}

function loadTs(file) {
  const key = path.resolve(file);
  if (moduleCache.has(key)) return moduleCache.get(key).exports;
  const code = jiti.transform({ source: fs.readFileSync(key, "utf8"), filename: key, ts: true });
  const module = { exports: {} };
  moduleCache.set(key, module); // pre-register for circular imports
  const localRequire = (spec) => {
    const r = resolveSpec(spec, key);
    return r.native ? nativeRequire(spec) : loadTs(r.file);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", code)(
    module.exports, localRequire, module, key, path.dirname(key));
  return module.exports;
}

// Isolate .perf/ writes into a tempdir; this test runs in its own process.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perf-adapter-"));
process.chdir(tmp);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const adapter = loadTs(path.join(REPO_ROOT, "perf", "index.ts"));

// ── mock ssh: distinguish bench / snapshot / cat by the ssh argv body ──
const TORCH_TRACE = {
  traceEvents: [
    { ph: "X", cat: "cpu_op", name: "aten::matmul", ts: 1000, dur: 500, args: { "Input Dims": [[128, 256], [256, 512]] } },
    { ph: "X", cat: "kernel", name: "ampere_sgemm_128x64_tn", ts: 1100, dur: 420, args: {} },
    { ph: "X", cat: "cpu_op", name: "aten::add", ts: 1600, dur: 50, args: {} },
    { ph: "M", name: "ProcessSheet" },
  ],
};

let benchCalls = 0;
adapter.__setExecForTest(async (argv) => {
  const body = argv[2] ?? "";
  if (body.includes("nvidia-smi --query-gpu")) {
    return { stdout: "NVIDIA H20, 570.0, 1740, 1980\n", stderr: "", code: 0 };
  }
  if (body.includes("cat /t/trace.json")) {
    return { stdout: JSON.stringify(TORCH_TRACE), stderr: "", code: 0 };
  }
  // bench run: parse the measured-loop run count from the generated script,
  // emit that many PERF_VAL lines; first bench call = base ~12.x, second ~8.x.
  benchCalls++;
  const matches = [...body.matchAll(/\$\(seq 1 (\d+)\)/g)];
  const runs = matches.length ? Number(matches[matches.length - 1][1]) : 5;
  const base = benchCalls === 1 ? 12.0 : 8.0;
  const lines = Array.from({ length: runs }, (_, i) => `PERF_VAL ${(base + i * 0.1).toFixed(1)}`).join("\n");
  return { stdout: lines, stderr: "", code: 0 };
});

// ── 1. bench_run full path ──
const out = await adapter.benchRunForTest({ host: "mock", workdir: "/w", command: "python b.py", runs: 5, warmup: 1 });
check("bench_run: returns p50", typeof out.stats.p50 === "number");
check("bench_run: warmup not counted (values === runs)", out.stats.values.length === 5);
check("bench_run: env snapshot attached", (out.snapshot || "").includes("H20"));
check("bench_run: .perf file written", fs.existsSync(out.filePath) && JSON.parse(fs.readFileSync(out.filePath, "utf8")).stats.p50 > 0);
check("bench_run: markdown summary present", typeof out.markdown === "string" && out.markdown.includes("P50"));

// ── 2. metric_compare on two persisted files ──
const out2 = await adapter.benchRunForTest({ host: "mock", workdir: "/w", command: "python b.py", runs: 5, warmup: 1 });
const cmp = await adapter.compareForTest(out.filePath, out2.filePath, "lower");
check("compare: verdict in enum", ["improve", "regress", "noise"].includes(cmp.verdict));
check("compare: returns p and deltaPct", typeof cmp.p === "number" && typeof cmp.deltaPct === "number");

// ── 3. profile_parse full path ──
const rep = await adapter.profileParseForTest("/t/trace.json", 5);
check("profile: markdown table header", (rep.markdown || "").includes("| op |"));
check("profile: matmul present in report", (rep.report.topN || []).some((e) => e.name === "aten::matmul"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
