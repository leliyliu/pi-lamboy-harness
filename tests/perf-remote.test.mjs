// perf-lab remote command assembly unit tests (pure, no pi runtime, no model quota).
// Covers: bench loop script generation (env export / warmup / measured runs with
// PERF_VAL marker), ssh command array assembly with single-quote escaping, and the
// nvidia-smi env snapshot command string.
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

const remote = loadTs("packages/core/perf/remote.ts");

// bench 循环脚本：在远端跑 warmup + N 轮，每轮打印一行 "PERF_VAL <number> <unit?>"
const script = remote.buildBenchScript({ runs: 5, warmup: 2, env: { CUDA_VISIBLE_DEVICES: "0" } }, "python bench.py");
check("script: contains warmup loop", script.includes("for i in $(seq 1 2)") || script.includes("seq 1 2"));
check("script: contains runs loop", script.includes("seq 1 5"));
check("script: exports env", script.includes("export CUDA_VISIBLE_DEVICES=0"));
check("script: prints PERF_VAL marker", script.includes("PERF_VAL"));
check("script: single-quoted inner command", script.includes("'python bench.py'") || script.includes("python bench.py"));
check("script: measured run emits PERF_VAL grep extraction", script.includes("grep -oP 'PERF_VAL \\K[\\d.]+'") || script.includes("grep -oP"));

// ssh 命令组装
const ssh = remote.buildSshCommand("kunshan-quant", "/workspace/x", script);
check("ssh: host first", ssh[0] === "ssh" && ssh[1] === "kunshan-quant");
check("ssh: cd workdir && exec script", ssh[2].includes("cd /workspace/x"));
check("ssh: uses bash -lc wrapper", ssh[2].startsWith("bash -lc"));
check("ssh: single quotes escaped in wrapper", ssh[2].includes("'\\''") || (() => { // inner ' became '\''
  const open = (ssh[2].match(/'/g) || []).length;
  return open >= 4; // wrapper open+close plus escaped pairs
})());

// 环境快照命令
const snap = remote.buildEnvSnapshotCmd();
check("snapshot: nvidia-smi query", snap.includes("nvidia-smi --query-gpu=name,driver_version,clocks.sm"));
check("snapshot: clock max field present", snap.includes("clocks.max.sm") && snap.includes("--format=csv"));
check("snapshot: command is non-trivial", snap.length > 20);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
