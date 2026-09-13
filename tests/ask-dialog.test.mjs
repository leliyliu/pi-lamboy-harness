// ask/dialog.ts — QuestionDialogComponent key-routing regression tests.
// Drives the REAL component (jiti-compiled) with raw key sequences,
// mirroring what the TUI delivers to handleInput ("\r" enter, " " space,
// "\x1b[A/B" arrows). Covers the multi-select Enter bug found in
// start-my-day sessions (multi_select questions silently skipped):
// Enter on an empty multi-select selection must pick the cursor option,
// not advance with nothing selected.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { jitiUrl } from "./jiti-path.mjs";

const { createJiti } = await import(jitiUrl());
const jiti = createJiti(import.meta.url, { moduleCache: false });
const nativeRequire = createRequire(import.meta.url);

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

function resolveSpec(spec, parentFile) {
  if (!spec.startsWith(".")) return { native: spec };
  const clean = spec.endsWith(".js") ? spec.slice(0, -3) : spec;
  const base = path.resolve(path.dirname(parentFile), clean);
  for (const c of [base + ".ts", base + ".js", base]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c };
  }
  throw new Error(`Cannot resolve ${spec} from ${parentFile}`);
}

function loadTs(file) {
  const key = path.resolve(file);
  const code = jiti.transform({ source: fs.readFileSync(key, "utf8"), filename: key, ts: true });
  const module = { exports: {} };
  const localRequire = (spec) => {
    const r = resolveSpec(spec, key);
    return r.native ? nativeRequire(spec) : loadTs(r.file);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", code)(
    module.exports, localRequire, module, key, path.dirname(key));
  return module.exports;
}

const { QuestionDialogComponent } = loadTs(`${EXT}/ask/dialog.ts`);
const { normalizeQuestions } = loadTs(`${EXT}/packages/core/ask/types.ts`);

const theme = { fg: (_c, s) => s, bold: (s) => s };
const ENTER = "\r";
const SPACE = " ";
const DOWN = "\x1b[B";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

/** Run the dialog over a key sequence; returns { result, dialog }. */
function drive(specsInput, keys) {
  const specs = normalizeQuestions(specsInput);
  let result = null;
  const dlg = new QuestionDialogComponent(specs, theme, (r) => { result = r; });
  dlg.render(100);
  for (const k of keys) dlg.handleInput(k);
  dlg.render(100);
  return { result, dlg, specs };
}

const THREE = {
  questions: [
    { question: "Q1", header: "目标", multi_select: true, options: [{ label: "A" }, { label: "B" }] },
    { question: "Q2", header: "想法", options: [{ label: "x" }, { label: "y" }] },
    { question: "Q3", header: "阻碍", options: [{ label: "m" }, { label: "n" }] },
  ],
};

// ── The bug: Enter on empty multi-select ──────────────────────

// 1. Enter on empty multi-select picks the cursor option (was: silent skip).
{
  const { result } = drive(THREE, [ENTER, "1", "1", ENTER]);
  check("multi Enter(empty) picks cursor option", result !== null && JSON.stringify(result.states[0].answer()) === JSON.stringify(["A"]), `got ${result && JSON.stringify(result.states.map((s) => s.answer()))}`);
  check("multi Enter(empty) dialog closes after last+submit", result !== null && result.cancelled === false);
}

// 2. Down+Enter on empty multi-select picks the option under the cursor.
{
  const { result } = drive(THREE, [DOWN, ENTER, "1", "1", ENTER]);
  check("multi ↓+Enter(empty) picks 2nd option", result !== null && JSON.stringify(result.states[0].answer()) === JSON.stringify(["B"]));
}

// 3. Answering the last question lands on the submit page, not a wrap-around.
{
  const { dlg } = drive(THREE, [ENTER, "1", "1"]);
  check("after last answer → submit page (tab=specs.length)", dlg["tab"] === THREE.questions.length, `tab=${dlg["tab"]}`);
}

// 4. Existing semantics preserved: toggle A + B then Enter confirms BOTH.
{
  const { result } = drive(THREE, ["1", "2", ENTER, "1", "1", ENTER]);
  check("digits toggle then Enter confirms set", result !== null && JSON.stringify(result.states[0].answer()) === JSON.stringify(["A", "B"]));
}

// 5. Existing semantics preserved: Space toggles then Enter confirms.
{
  const { result } = drive(THREE, [SPACE, DOWN, SPACE, ENTER, "1", "1", ENTER]);
  check("Space toggle then Enter confirms set", result !== null && JSON.stringify(result.states[0].answer()) === JSON.stringify(["A", "B"]));
}

// 6. Non-empty selection: Enter does NOT add the cursor option (checkbox confirm).
{
  const { result } = drive(THREE, ["1", DOWN, ENTER, "1", "1", ENTER]);
  check("Enter with selection confirms without adding cursor", result !== null && JSON.stringify(result.states[0].answer()) === JSON.stringify(["A"]));
}

// 7. Toggle then untoggle leaves selection empty → Enter picks cursor again.
{
  const { result } = drive(THREE, ["1", "1", ENTER, "1", "1", ENTER]);
  check("toggle twice → empty → Enter picks cursor", result !== null && JSON.stringify(result.states[0].answer()) === JSON.stringify(["A"]));
}

// ── Regression guards (unchanged behavior) ────────────────────

// 8. Single-select: Enter activates the cursor option (permission path).
{
  const { result } = drive({ question: "Run?", options: ["Allow", "Deny"] }, [DOWN, ENTER]);
  check("single ↓+Enter answers 2nd option", result !== null && result.states[0].answer() === "Deny");
}

// 9. Single-select: digit answers immediately.
{
  const { result } = drive({ question: "Run?", options: ["Allow", "Deny"] }, ["2"]);
  check("single digit answers immediately", result !== null && result.states[0].answer() === "Deny");
}

// 10. Multi-select: Enter on the Other row opens the free-text editor.
{
  const { result, dlg } = drive(THREE, [DOWN, DOWN, ENTER]); // cursor → Other (2 opts + Other)
  check("multi Enter on Other opens editor", result === null && dlg["states"][0].editingOther === true);
}

// 11. Multi-select: Enter on the Chat row ends with chatIndex.
{
  const { result } = drive(THREE, [DOWN, DOWN, DOWN, ENTER]); // cursor → Chat
  check("multi Enter on Chat → chatIndex 0", result !== null && result.chatIndex === 0);
}

// 12. Esc cancels (still open states preserved).
{
  const { result } = drive(THREE, ["1", "\x1b"]);
  check("Esc cancels", result !== null && result.cancelled === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
