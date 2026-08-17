// latex-toolchain bib consistency check unit tests (pure, no pi runtime).
// Covers: duplicate bib keys, undefined \cite keys, unused bib entries, and
// the clean case over the good/ fixture (which compiles under real tectonic).
// Uses the same jiti.transform CJS loader as tests/latex-parse.test.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { jitiUrl } from "./jiti-path.mjs";
const { createJiti } = await import(jitiUrl());
const jiti = createJiti(import.meta.url ?? __filename, { moduleCache: false });
const nativeRequire = createRequire(import.meta.url);
const moduleCache = new Map();

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");

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

const bc = loadTs("packages/core/latex/bib-check.ts");
const fx = (p) => fs.readFileSync(path.join(ROOT, "tests/fixtures/latex", p), "utf8");

// good: 8 citations, 8 bib entries, no duplicates, all cited → zero issues
const g = bc.checkBib(fx("good/main.tex"), fx("good/refs.bib"));
check("good: no issues", g.issues.length === 0, JSON.stringify(g.issues));

// bad-refs: three issue kinds, each present
const b = bc.checkBib(fx("bad-refs/main.tex"), fx("bad-refs/refs.bib"));
check("bad: duplicate key smith2020", b.issues.some(i => i.kind === "duplicate-key" && i.detail.includes("smith2020")), JSON.stringify(b.issues));
check("bad: undefined citation ghost2022", b.issues.some(i => i.kind === "undefined-citation" && i.detail.includes("ghost2022")), JSON.stringify(b.issues));
check("bad: unused entry jones2021", b.issues.some(i => i.kind === "unused-entry" && i.detail.includes("jones2021")), JSON.stringify(b.issues));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
