// perf-lab core stats unit tests (pure, no pi runtime, no model quota).
// Covers: quantiles (linear interpolation), MAD, MAD-based outlier
// filtering, Mann-Whitney U significance, compareStats verdicts.
// Uses the same jiti.transform CJS loader as tests/tui-box.test.mjs.
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

const stats = loadTs("packages/core/perf/stats.ts");

// quantiles
check("quantiles: p50 of [1..9] === 5", stats.quantile([1,2,3,4,5,6,7,8,9], 0.5) === 5);
check("quantiles: p95 of 100 zeros + one 1000 === 0 (linear interp)", stats.quantile([...Array(100).fill(0), 1000], 0.95) === 0);
check("quantiles: empty array returns null", stats.quantile([], 0.5) === null);

// MAD (median absolute deviation)
check("mad: [1,1,2,2,4,6,9] → median 2, MAD 1", stats.mad([1,1,2,2,4,6,9]) === 1);

// outlier 剔除（MAD 法：|x - med| > 3.5 * MAD 剔除）
check("filterOutliers: removes the 1000 spike", JSON.stringify(stats.filterOutliers([...Array(20).fill(5), 1000])) === JSON.stringify(Array(20).fill(5)));
check("filterOutliers: all-identical data kept intact", stats.filterOutliers([3,3,3]).length === 3);

// Mann-Whitney U（用于 A/B 显著性）
const bigA = Array(20).fill(10).map((v,i)=>v+i*0.1);      // 10.0..11.9
const bigB = Array(20).fill(20).map((v,i)=>v+i*0.1);      // 20.0..21.9 — 完全分离
const noisy = Array(20).fill(10).map((v,i)=>v+(i%2?0.5:-0.5));
const mw = stats.mannWhitney(bigA, bigB);
check("mwU: separated groups → p < 0.01", mw.p < 0.01);
check("mwU: identical-ish groups → p > 0.05", stats.mannWhitney(bigA, noisy).p > 0.05);

// compareStats：显著性 + 判定建议
const cs = stats.compareStats(
  { values: bigA, label: "base" },
  { values: bigB, label: "cand" },
  { direction: "lower" }   // lower is better
);
check("compare: separated improvement → verdict improve", cs.verdict === "improve");
check("compare: reports deltaPct", typeof cs.deltaPct === "number" && cs.deltaPct < -40);
check("compare: noise case → verdict noise", stats.compareStats({values: bigA, label:"a"},{values: noisy, label:"b"},{direction:"lower"}).verdict === "noise");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
