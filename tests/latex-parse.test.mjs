// latex-toolchain log parser unit tests (pure, no pi runtime, no model quota).
// Covers: tectonic single-line "error: file:line: message" parsing, noise-line
// filtering (XeTeX engine chatter), severity detection, fix hints, rawTail.
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

const parse = loadTs("packages/core/latex/parse-log.ts");

// Real tectonic 0.17.0 error output (calibrated 2026-08-14):
//   error: <file>:<line>: <message>   — single-line, no "==>" continuation
//   engine chatter lines carry no file:line and must be filtered.
const TECTONIC_ERR = `error: main.tex:12: Missing $ inserted
error: something bad happened inside XeTeX; its output follows:
error: the XeTeX engine had an unrecoverable error
caused by: halted on potentially-recoverable error as specified
`;

check("err: file+line extracted", (() => {
  const r = parse.parseTectonicLog(TECTONIC_ERR);
  return r.errors.length >= 1 && r.errors[0].file === "main.tex" && r.errors[0].line === 12;
})());
check("err: message captured", parse.parseTectonicLog(TECTONIC_ERR).errors[0].message.includes("Missing $"));
check("err: severity error", parse.parseTectonicLog(TECTONIC_ERR).errors[0].severity === "error");
check("err: missing-$ gets math hint", parse.parseTectonicLog(TECTONIC_ERR).errors[0].hint?.includes("math") === true);
check("err: engine chatter filtered (1 real error, not 4)", parse.parseTectonicLog(TECTONIC_ERR).errors.length === 1);

// Warning: same single-line format. tectonic console does not surface
// undefined-reference warnings itself (it silently reruns), but biber and
// future callers may emit "warning: file:line: message" — parse it best-effort.
const TECTONIC_WARN = `warning: main.tex:20: undefined reference "sec:ghost"
`;
check("warn: severity warning", parse.parseTectonicLog(TECTONIC_WARN).errors[0].severity === "warning");
check("hint: undefined-ref gets rerun hint", parse.parseTectonicLog(TECTONIC_WARN).errors[0].hint?.toLowerCase().includes("rerun") === true);
check("warn: file+line captured", (() => {
  const w = parse.parseTectonicLog(TECTONIC_WARN).errors[0];
  return w.file === "main.tex" && w.line === 20;
})());

// Undefined control sequence hint
const CTRL_SEQ = `error: main.tex:3: undefined control sequence \\foobar
`;
check("hint: undefined control sequence", parse.parseTectonicLog(CTRL_SEQ).errors[0].hint?.includes("macro") === true);

// Clean run
check("clean: no errors", parse.parseTectonicLog("note: Running TeX ...\nnote: Writing `main.pdf`\n").errors.length === 0);

// Mixed: error block + warning line → exactly 2 structured entries
check("multi: two entries both captured", parse.parseTectonicLog(TECTONIC_ERR + TECTONIC_WARN).errors.length === 2);

// rawTail: last 30 lines preserved as fallback context
const raw = parse.parseTectonicLog(TECTONIC_ERR).rawTail;
check("rawTail: contains engine chatter tail", raw.includes("unrecoverable error") && raw.includes("caused by"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
