// AgentPauseGate + renderPauseScreen unit tests (pure, no pi runtime).
const { AgentPauseGate } = await import("../packages/core/pause/gate.ts");
const { renderPauseScreen, formatPauseDuration, formatPauseClock, displayWidth } = await import(
  "../packages/core/pause/lines.ts"
);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) pass++;
  else { fail++; console.log(`FAIL: ${name} ${extra}`); }
}

// ── 1. initial state ─────────────────────────────────────────
const g = new AgentPauseGate();
check("initial: not paused", g.paused === false);
check("initial: pausedAt undefined", g.pausedAt === undefined);

// ── 2. pause() ───────────────────────────────────────────────
check("pause: returns true", g.pause() === true);
check("pause: paused true", g.paused === true);
check("pause: pausedAt set", typeof g.pausedAt === "number");
const firstPausedAt = g.pausedAt;
check("pause: repeat returns false", g.pause() === false);
check("pause: repeat keeps pausedAt", g.pausedAt === firstPausedAt);

// ── 3. resume() ──────────────────────────────────────────────
const dur = g.resume();
check("resume: returns number duration", typeof dur === "number" && dur >= 0);
check("resume: paused false", g.paused === false);
check("resume: pausedAt undefined", g.pausedAt === undefined);
check("resume: not paused returns undefined", g.resume() === undefined);

// ── 4. subscribe ─────────────────────────────────────────────
const events = [];
const unsub = g.subscribe((p) => events.push(p));
g.pause();
g.resume();
check("subscribe: got true then false", events.length === 2 && events[0] === true && events[1] === false);
events.length = 0;
unsub();
g.pause();
g.resume();
check("subscribe: unsubscribed stops notifications", events.length === 0);

// ── 5. waitUntilResumed ──────────────────────────────────────
check("wait: resolves immediately when not paused", await Promise.race([
  g.waitUntilResumed().then(() => "resolved"),
  new Promise((r) => setTimeout(() => r("timeout"), 100)),
]) === "resolved");

// Paused: waiter hangs until resume
g.pause();
let released = false;
const waiter = g.waitUntilResumed().then(() => { released = true; });
await new Promise((r) => setTimeout(r, 50));
check("wait: hangs while paused", released === false);
g.resume();
await waiter;
check("wait: resolves after resume", released === true);

// ── 6. AbortSignal releases only the wait ────────────────────
g.pause();
const ac = new AbortController();
const aborted = g.waitUntilResumed(ac.signal).then(() => "aborted");
ac.abort();
check("wait: abort resolves the wait", await aborted === "aborted");
check("wait: gate stays paused after abort", g.paused === true);
g.resume();

// ── 6b. pausedOrigin ─────────────────────────────────────────
check("origin: undefined before pause", g.pausedOrigin === undefined);
g.pause();
check("origin: undefined at manual pause", g.pausedOrigin === undefined);
const originWaiter = g.waitUntilResumed(undefined, "tool_call");
await new Promise((r) => setTimeout(r, 10));
check("origin: captured from parked waiter", g.pausedOrigin === "tool_call");
const beforeResume = g.pausedOrigin;
check("origin: second origin does not overwrite", g.waitUntilResumed(undefined, "other") === undefined || g.pausedOrigin === beforeResume);
g.resume();
await originWaiter;
check("origin: cleared after resume", g.pausedOrigin === undefined);

// ── 7. formatPauseDuration / formatPauseClock ────────────────
check("dur: 5s", formatPauseDuration(5000) === "5s");
check("dur: 65s -> 1m 05s", formatPauseDuration(65000) === "1m 05s");
check("dur: 3660s -> 1h 01m", formatPauseDuration(3660000) === "1h 01m");
check("clock: 7s -> 0:07", formatPauseClock(7000) === "0:07");
check("clock: 65s -> 1:05", formatPauseClock(65000) === "1:05");
check("clock: 3723s -> 1:02:03", formatPauseClock(3723000) === "1:02:03");

// ── 8. renderPauseScreen (fullscreen) ────────────────────────
const now = Date.now();
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const full = { width: 100, height: 30, pausedAt: now - 5000, nowMs: now };

const f1 = renderPauseScreen(full);
check("screen: exactly height rows", f1.length === 30);
// Backdrop is plain spaces (terminal background shows through) — no fixed bg color.
const f1plain = f1.every((s) => !s.includes("\x1b[48;"));
check("screen: backdrop is terminal bg (no fixed bg)", f1plain);
// Display width: █ (U+2588) and ⏸ (U+23F8) are single-width; CJK is 2-col.
check("screen: every row is full width", f1.every((s) => displayWidth(strip(s)) === 100));
check("width: block glyphs are single-width", displayWidth("██") === 2);
check("width: pause symbol is single-width", displayWidth("⏸") === 1);
check("width: CJK is double-width", displayWidth("暂停") === 4);
check("width: CJK punctuation double-width", displayWidth("，") === 2);
const f1text = f1.map(strip).join("\n");
check("screen: PAUSED header", f1text.includes("⏸ PAUSED"));
check("screen: clock 0:05", f1text.includes("paused for 0:05"));
check("screen: body lines present", f1text.includes("主代理将在下一步暂停"));
check("screen: resume hint present", f1text.includes("esc/enter/space/ctrl+c 释放"));
// ⏸ (1 col) + " PAUSED" (7) = 8 cols -> pad = floor((100-8)/2) = 46
check("screen: title centered", /^ {46}⏸ PAUSED/.test(strip(f1.find((s) => strip(s).includes("⏸ PAUSED")) ?? "")));
// Icon glyph row: 5+1+5 single-width blocks + 4 gap = 14 cols -> pad = 43
check("screen: icon row centered", /^ {43}█████ {4}█████ {43}$/.test(strip(f1.find((s) => strip(s).includes("█████")) ?? "")));
// Default style wraps content in fixed ANSI fg colors (omp-like fallback).
check("screen: default style colors present", f1.some((s) => s.includes("\x1b[38;2;255;159;67m")));

// Icon bars: 7 rows of the double-bar glyph
const bars = f1.filter((s) => strip(s).trim() === "█████    █████");
check("screen: 7 icon bar rows", bars.length === 7);

// Custom theme style injection
const f1s = renderPauseScreen({ ...full, style: { accent: (s) => `[A]${s}[/A]`, text: (s) => `[T]${s}[/T]`, muted: (s) => `[M]${s}[/M]`, dim: (s) => `[D]${s}[/D]` } });
const f1stext = f1s.map(strip).join("\n");
check("style: accent used for icon bars", f1s.some((s) => s.includes("[A]█████")));
check("style: text used for title", f1stext.includes("[T]⏸ PAUSED[/T]"));
check("style: muted used for body", f1stext.includes("[M]主代理"));
check("style: dim used for hints", f1stext.includes("[D]esc/enter/space/ctrl+c 释放[/D]"));

// Origin tag
const f2 = renderPauseScreen({ ...full, pausedOrigin: "tool_call" });
check("screen: tool_call tag present", f2.some((s) => strip(s).includes("<tool_call>")));

// Compact degradation (small terminal)
const f3 = renderPauseScreen({ width: 40, height: 12, pausedAt: now - 5000, nowMs: now });
const f3text = f3.map(strip).join("\n");
check("compact: full height rows", f3.length === 12);
check("compact: header + clock", f3text.includes("⏸ PAUSED") && f3text.includes("paused for 0:05"));
check("compact: no body lines", !f3text.includes("主代理将在下一步暂停"));
check("compact: no icon bars", f3.every((s) => !strip(s).trim().startsWith("█████")));

// Tiny dimensions never throw and stay bounded
const f4 = renderPauseScreen({ width: 10, height: 1, pausedAt: now - 5000, nowMs: now });
check("tiny: 1 row, no throw", f4.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
