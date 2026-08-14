// TUI state visualization unit tests (pure, no pi runtime, no model quota).
// Covers: command argument completions (prefix filter / empty fallback /
// multi-token budget units), spinner styles, and the keep-alive gate.
// Uses the same jiti.transform CJS loader as tests/permission.test.mjs.
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

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const completions = loadTs(`${EXT}/packages/core/completions.ts`);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// ══════════════════════════════════════════════════════════════
// 1. filterCompletions — prefix filter + empty-result fallback
// ══════════════════════════════════════════════════════════════
const ITEMS = [
  { value: "on", label: "on" },
  { value: "off", label: "off" },
  { value: "status", label: "status" },
];

check("filter: empty prefix returns full list",
  completions.filterCompletions(ITEMS, "").length === 3);
check("filter: prefix narrows to matches",
  completions.filterCompletions(ITEMS, "o").length === 2);
check("filter: exact single match",
  completions.filterCompletions(ITEMS, "st").length === 1
  && completions.filterCompletions(ITEMS, "st")[0].value === "status");
check("filter: no-match prefix falls back to full list",
  completions.filterCompletions(ITEMS, "zzz").length === 3);
check("filter: case-insensitive prefix",
  completions.filterCompletions(ITEMS, "OF").length === 1
  && completions.filterCompletions(ITEMS, "OF")[0].value === "off");

// ══════════════════════════════════════════════════════════════
// 2. /goal completions — subcommands + budget units
// ══════════════════════════════════════════════════════════════
const goalAll = completions.goalArgumentCompletions("");
const goalValues = goalAll.map((i) => i.value);
const expectedSubs = ["pause", "resume", "cancel", "replace", "next", "status",
  "queue", "add", "prioritize", "drop", "skip", "budget"];
check("goal: all 12 subcommands present",
  expectedSubs.every((s) => goalValues.includes(s)),
  `got: ${goalValues.join(",")}`);

check("goal: prefix 'p' → pause + prioritize",
  (() => {
    const v = completions.goalArgumentCompletions("p").map((i) => i.value);
    return v.includes("pause") && v.includes("prioritize") && !v.includes("resume");
  })());
check("goal: no-match prefix falls back to full list",
  completions.goalArgumentCompletions("zzz").length === goalAll.length);

// budget: typing the number → no completion
check("goal: 'budget' + space → null (number expected)",
  completions.goalArgumentCompletions("budget ") === null);
check("goal: 'budget 10' (typing number) → null",
  completions.goalArgumentCompletions("budget 10") === null);

// budget: after number + space → all units, values carry full argument text
const budgetUnits = completions.goalArgumentCompletions("budget 10 ");
check("goal: 'budget 10 ' → 6 unit completions",
  budgetUnits !== null && budgetUnits.length === 6);
check("goal: unit values are full argument strings",
  budgetUnits !== null && budgetUnits.every((i) => i.value.startsWith("budget 10 ")));
check("goal: unit set is turns/tokens/ms/s/minutes/hours",
  budgetUnits !== null && ["turns", "tokens", "ms", "s", "minutes", "hours"]
    .every((u) => budgetUnits.some((i) => i.value === `budget 10 ${u}`)));

// budget: unit prefix filter
const budgetT = completions.goalArgumentCompletions("budget 10 t");
check("goal: 'budget 10 t' → turns + tokens",
  budgetT !== null && budgetT.length === 2
  && budgetT.some((i) => i.value === "budget 10 turns")
  && budgetT.some((i) => i.value === "budget 10 tokens"));
check("goal: 'budget 10 h' → hours only",
  (() => {
    const r = completions.goalArgumentCompletions("budget 5 h");
    return r !== null && r.length === 1 && r[0].value === "budget 5 hours";
  })());
check("goal: unit no-match falls back to all units",
  completions.goalArgumentCompletions("budget 10 zzz").length === 6);
check("goal: completed unit + space → null",
  completions.goalArgumentCompletions("budget 10 turns ") === null);

// ══════════════════════════════════════════════════════════════
// 3. /plan, /mode completions
// ══════════════════════════════════════════════════════════════
check("plan: on/off/clear present",
  (() => {
    const v = completions.planArgumentCompletions("").map((i) => i.value);
    return v.includes("on") && v.includes("off") && v.includes("clear");
  })());
check("plan: prefix 'c' → clear only",
  (() => {
    const v = completions.planArgumentCompletions("c").map((i) => i.value);
    return v.length === 1 && v[0] === "clear";
  })());

check("mode: auto/yolo/manual (+status) present",
  (() => {
    const v = completions.modeArgumentCompletions("").map((i) => i.value);
    return v.includes("auto") && v.includes("yolo") && v.includes("manual");
  })());
check("mode: prefix 'y' → yolo only",
  (() => {
    const v = completions.modeArgumentCompletions("y").map((i) => i.value);
    return v.length === 1 && v[0] === "yolo";
  })());
check("mode: no-match falls back to full list",
  completions.modeArgumentCompletions("zzz").length === 4);

// ══════════════════════════════════════════════════════════════
// 4. Spinner styles (harness-branded, PI_MUSELINN_SPINNER)
// ══════════════════════════════════════════════════════════════
const spinner = loadTs(`${EXT}/packages/core/tui/spinner.ts`);
const { getSpinnerFrames, SPINNER_STYLES, DEFAULT_SPINNER_STYLE, FRAME_INTERVAL_MS } = spinner;

delete process.env.PI_MUSELINN_SPINNER;
check("spinner: default style is braille",
  DEFAULT_SPINNER_STYLE === "braille"
  && getSpinnerFrames() === SPINNER_STYLES.braille);
check("spinner: braille frames are single-width (no emoji)",
  SPINNER_STYLES.braille.every((f) => [...f].length === 1 && f.charCodeAt(0) >= 0x2800 && f.charCodeAt(0) <= 0x28ff));
check("spinner: frame interval is 250ms", FRAME_INTERVAL_MS === 250);

process.env.PI_MUSELINN_SPINNER = "pulse";
check("spinner: env override selects pulse",
  getSpinnerFrames() === SPINNER_STYLES.pulse);

process.env.PI_MUSELINN_SPINNER = "BOUNCE";
check("spinner: env override is case-insensitive",
  getSpinnerFrames() === SPINNER_STYLES.bounce);

process.env.PI_MUSELINN_SPINNER = "moon";
check("spinner: legacy moon style still available",
  getSpinnerFrames() === SPINNER_STYLES.moon && SPINNER_STYLES.moon.length === 8);

process.env.PI_MUSELINN_SPINNER = "nonexistent";
check("spinner: unknown style falls back to braille",
  getSpinnerFrames() === SPINNER_STYLES.braille);
delete process.env.PI_MUSELINN_SPINNER;

// ── spinner keep-alive gate (wall-clock piggyback render) ──
const { shouldKeepAliveRender, wallClockFrameIndex, KEEP_ALIVE_QUIET_MS } = loadTs(`${EXT}/packages/core/tui/keepalive.ts`);
check("keep-alive: not working -> no render",
  shouldKeepAliveRender(false, 0, 10000) === false);
check("keep-alive: working + recent render (10ms ago) -> skip",
  shouldKeepAliveRender(true, 9990, 10000) === false);
check("keep-alive: working + quiet below threshold (150ms ago) -> skip",
  shouldKeepAliveRender(true, 9850, 10000) === false);
check("keep-alive: working + quiet >= threshold (250ms ago) -> render",
  shouldKeepAliveRender(true, 9750, 10000) === true);
check("keep-alive: never rendered (0) -> render",
  shouldKeepAliveRender(true, 0, 10000) === true);
check("keep-alive: quiet threshold is 200ms",
  KEEP_ALIVE_QUIET_MS === 200);
check("wall-clock frame: advances by time, wraps around",
  wallClockFrameIndex(8, 0, 250) === 0 && wallClockFrameIndex(8, 250, 250) === 1 &&
  wallClockFrameIndex(8, 2000, 250) === 0 && wallClockFrameIndex(8, 2250, 250) === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
