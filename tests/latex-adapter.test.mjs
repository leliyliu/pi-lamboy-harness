// latex-toolchain adapter tests — mock-tectonic full-path coverage, no pi
// runtime needed. Covers: latex_compile (success / structured errors /
// missing-binary friendly error), bibtex_check (three issue kinds from the
// bad-refs fixture). Uses the same jiti CJS loader as tests/perf-adapter.
import * as fs from "node:fs";
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = (p) => path.join(REPO_ROOT, "tests/fixtures/latex", p);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const adapter = loadTs(path.join(REPO_ROOT, "latex", "index.ts"));

// Real tectonic 0.17.0 error output (calibrated in task 1 fixtures).
const TECTONIC_ERR = `error: main.tex:12: Missing $ inserted
error: something bad happened inside XeTeX; its output follows:
error: the XeTeX engine had an unrecoverable error
caused by: halted on potentially-recoverable error as specified
`;

// ── mock tectonic: distinguish good / bad-syntax by the tex path (last argv) ──
adapter.__setExecForTest(async (argv) => {
  const texArg = argv[argv.length - 1] ?? "";
  if (texArg.includes("good")) {
    return { stdout: "note: Running TeX...\nnote: writing `main.pdf` (2 pages, 12523 bytes)\n", stderr: "", code: 0 };
  }
  if (texArg.includes("bad-syntax")) {
    return { stdout: TECTONIC_ERR, stderr: "", code: 1 };
  }
  return { stdout: "", stderr: "", code: 0 };
});

// ── 1. latex_compile success path ──
const ok = await adapter.compileForTest(FX("good/main.tex"));
check("compile good: ok true", ok.ok === true && ok.errors.length === 0);
check("compile good: pdfPath set", typeof ok.pdfPath === "string" && ok.pdfPath.endsWith("main.pdf"));
check("compile good: markdown mentions pdf", ok.markdown.includes("pdf"));

// ── 2. latex_compile error path ──
const bad = await adapter.compileForTest(FX("bad-syntax/main.tex"));
check("compile bad: ok false", bad.ok === false);
check("compile bad: structured line 12 error", bad.errors.length >= 1 && bad.errors[0].line === 12);
check("compile bad: markdown table", bad.markdown.includes("| severity |") && bad.markdown.includes("Missing $"));

// ── 3. missing tectonic ──
adapter.__setExecForTest(async () => ({ code: 127, stdout: "", stderr: "command not found" }));
const nf = await adapter.compileForTest(FX("good/main.tex"));
check("missing tectonic: ok false", nf.ok === false);
check("missing tectonic: friendly error", nf.errors[0].message.includes("brew install tectonic"));

// ── 4. bibtex_check full path (restore a harmless mock first) ──
adapter.__setExecForTest(null);
const bib = await adapter.bibCheckForTest(FX("bad-refs/main.tex"), FX("bad-refs/refs.bib"));
check("bib via adapter: markdown has 3 issue kinds", ["undefined-citation", "unused-entry", "duplicate-key"].every((k) => bib.markdown.includes(k)));
check("bib via adapter: issues array populated", bib.issues.length >= 3);

// ── 5. bibtex_check auto-infer: <name>.bib 不存在时明确报错 ──
let autoErr = "";
try { await adapter.bibCheckForTest(FX("bad-refs/main.tex")); } catch (e) { autoErr = String(e); }
check("bib auto-infer missing: clear not-found error", autoErr.includes("bib file not found") && autoErr.includes("main.bib"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
