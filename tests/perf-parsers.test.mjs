// perf-lab core parsers unit tests (pure, no pi runtime, no model quota).
// Covers: parseTorchProfile (chrome-trace X events -> aggregated hotspot
// table) and extractBenchValue (stdout -> {value, unit}).
// Uses the same jiti.transform CJS loader as tests/perf-stats.test.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

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

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const parsers = loadTs("packages/core/perf/parsers.ts");

// Minimal torch.profiler export_chrome_trace structure: X events for
// cpu_op/kernel categories + one non-X metadata event that must be ignored.
const TORCH_TRACE = {
  traceEvents: [
    { ph: "X", cat: "cpu_op", name: "aten::matmul", ts: 1000, dur: 500, args: { "External id": 1, "Input Dims": [[128, 256], [256, 512]] } },
    { ph: "X", cat: "kernel", name: "ampere_sgemm_128x64_tn", ts: 1100, dur: 420, args: {} },
    { ph: "X", cat: "cpu_op", name: "aten::add", ts: 1600, dur: 50, args: { "External id": 2 } },
    { ph: "X", cat: "kernel", name: "vectorized_elementwise_kernel", ts: 1650, dur: 45, args: {} },
    { ph: "M", name: "ProcessSheet" }, // non-X event must be ignored
  ],
};

const rep = parsers.parseTorchProfile(TORCH_TRACE, 5);
check("torch: totalUs is sum of the 4 X-event durations", rep.totalUs === 500 + 420 + 50 + 45);
check("torch: top1 is matmul (500us, sorted desc)", rep.topN[0].name === "aten::matmul");
check("torch: shape extracted from Input Dims", rep.topN.find(e => e.name === "aten::matmul").shape === "128x256 @ 256x512");
check("torch: kernel and cpu_op both present", rep.topN.some(e => e.name.includes("sgemm")) && rep.topN.some(e => e.name === "aten::add"));
check("torch: selfPct sums to ~100", Math.abs(rep.topN.reduce((s, e) => s + e.selfPct, 0) - 100) < 5);

// stdout extraction
check("stdout: do_bench style '123.45 us'", parsers.extractBenchValue("mean = 123.45 us")?.value === 123.45);
check("stdout: bare number on last line", parsers.extractBenchValue("loading...\n42.17\n")?.value === 42.17);
check(
  "stdout: multi-line stats prefer explicit mean",
  parsers.extractBenchValue("205.31 us\n1.2 ms\nmean: 205.31 us")?.value === 205.31
);
check("stdout: no numbers returns null", parsers.extractBenchValue("done, no numbers") === null);
check("stdout: unit recognized", parsers.extractBenchValue("990.3 ms")?.unit === "ms");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
