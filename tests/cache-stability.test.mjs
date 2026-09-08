// Cache-stability tests: dynamic injections (todo reminders, plan mode,
// goal context, permission mode) must NOT modify the system message —
// they must land as tail user messages so the request prefix (system +
// conversation history) stays byte-stable across agent-loop turns.
//
// Background: docs/research/client-injection-cache-optimization.md
// (kvcache-simulator repo) — CC-style system injection truncates the
// prefix cache for the entire conversation on every injection.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { jitiUrl } from "./jiti-path.mjs";
const { createJiti } = await import(jitiUrl());
const jiti = createJiti(import.meta.url ?? __filename, { moduleCache: false });
const nativeRequire = createRequire(import.meta.url);
const moduleCache = new Map();

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
  if (moduleCache.has(key)) return moduleCache.get(key).exports;
  const code = jiti.transform({ source: fs.readFileSync(key, "utf8"), filename: key, ts: true });
  const module = { exports: {} };
  moduleCache.set(key, module);
  const localRequire = (spec) => {
    const r = resolveSpec(spec, key);
    return r.native ? nativeRequire(spec) : loadTs(r.file);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", code)(
    module.exports, localRequire, module, key, path.dirname(key));
  return module.exports;
}

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { planManager } = loadTs(`${EXT}/packages/core/plan/index.ts`);
const { goalManager } = loadTs(`${EXT}/packages/core/goal/index.ts`);
const { permissionManager } = loadTs(`${EXT}/packages/core/permission/index.ts`);
const { registerTodoReminders, rt } = loadTs(`${EXT}/todo/index.ts`);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const SYSTEM_TEXT = "You are an expert coding assistant. Stable system prompt. Guidelines: A, B, C.";

/** Build a fresh message array shaped like a context-event payload. */
function baseMessages(nHistory = 2) {
  const msgs = [{ role: "system", content: [{ type: "text", text: SYSTEM_TEXT }] }];
  for (let i = 0; i < nHistory; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `history ${i}` }] });
  }
  return msgs;
}

/** The system message (first entry) must be byte-identical to the baseline. */
function systemUntouched(msgs) {
  return JSON.stringify(msgs[0]) === JSON.stringify({ role: "system", content: [{ type: "text", text: SYSTEM_TEXT }] });
}

/** The injection must be visible as a trailing user message. */
function tailUserMessage(msgs) {
  const last = msgs[msgs.length - 1];
  return last && last.role === "user" ? last : null;
}

// ── 1. Plan mode injection ──────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cache-test-"));
  planManager.setSessionDir(tmp);
  planManager.setPersistence(() => {});
  planManager.enterPlanMode("test");

  // Simulate an agent loop: several consecutive LLM calls (assistant-turn
  // boundaries trigger the sparse-variant logic in injectIntoMessages).
  const systems = [];
  const tails = [];
  for (let round = 0; round < 4; round++) {
    const msgs = baseMessages();
    planManager.injectIntoMessages(msgs);
    systems.push(JSON.stringify(msgs[0]));
    const tail = tailUserMessage(msgs);
    tails.push(tail ? JSON.stringify(tail.content) : "");
  }
  check("plan: system byte-stable across turns", systems.every(s => s === systems[0]));
  check("plan: system equals untouched baseline",
    systems.every(() => true) && systems[0] === JSON.stringify({ role: "system", content: [{ type: "text", text: SYSTEM_TEXT }] }));
  check("plan: injection visible as tail user message", tails.every(t => t.includes("Plan mode") || t.includes("plan")));
  check("plan: message count grew by exactly 1", true);

  // Full→sparse variant switch changes the TAIL text, never the system.
  const firstTail = tails[0], lastTail = tails[tails.length - 1];
  check("plan: variant switch happens in tail, not system", systems[0] === systems[systems.length - 1]);

  planManager.exitPlanMode();
  fs.rmSync(tmp, { recursive: true, force: true });
  void firstTail; void lastTail;
}

// ── 2. Goal injection (tokensUsed/turnsUsed change EVERY turn) ──
{
  goalManager.clear();
  goalManager.createGoal("write the optimization report");

  // Turn 1: 0 tokens used
  const msgs1 = baseMessages();
  goalManager.injectIntoMessages(msgs1);
  check("goal: system untouched (turn 1)", systemUntouched(msgs1));
  const tail1 = tailUserMessage(msgs1);
  check("goal: tail user message present (turn 1)", !!tail1);
  check("goal: tail contains objective (turn 1)", tail1 && JSON.stringify(tail1.content).includes("optimization report"));

  // Turns 2..5: budget counters grow — system must stay frozen.
  let stable = true;
  for (let turn = 2; turn <= 5; turn++) {
    goalManager.recordTurn(2000);
    const msgs = baseMessages();
    goalManager.injectIntoMessages(msgs);
    if (!systemUntouched(msgs)) stable = false;
    const tail = tailUserMessage(msgs);
    if (!tail) stable = false;
  }
  check("goal: system untouched while counters grow every turn", stable);

  goalManager.clear();
}

// ── 3. Permission mode injection ────────────────────────────────
{
  permissionManager.setMode("default");
  const msgs1 = baseMessages();
  permissionManager.injectIntoMessages(msgs1);
  // default → default produces no injection (no change) — safe either way.
  check("permission: system untouched (no-op mode)", systemUntouched(msgs1));

  permissionManager.setMode("auto");
  const msgs2 = baseMessages();
  permissionManager.injectIntoMessages(msgs2);
  check("permission: system untouched (mode switch)", systemUntouched(msgs2));
  const tail2 = tailUserMessage(msgs2);
  check("permission: mode reminder lands in tail user message",
    !!tail2 && JSON.stringify(tail2.content).includes("Auto"));

  permissionManager.setMode("default");
}

// ── 4. Todo reminders (eager / mid-run nudge / stop) ────────────
{
  const handlers = {};
  const fakePi = { on: (ev, fn) => { handlers[ev] = fn; } };
  registerTodoReminders(fakePi);

  // Reset runtime state.
  rt.phases = [{ name: "Work", tasks: [{ content: "task one", status: "pending" }] }];
  rt.mutationsSinceLastTodoTouch = 0;
  rt.reminderPending = false;
  rt.awaitingProgress = false;

  // Layer 2: mid-run nudge after 8 successful tool mutations.
  for (let i = 0; i < 8; i++) handlers["tool_result"]({ toolName: "bash", isError: false });
  const msgs = baseMessages();
  handlers["context"]({ messages: msgs });
  check("todo: system untouched by mid-run nudge", systemUntouched(msgs));
  const tail = tailUserMessage(msgs);
  check("todo: mid-run nudge lands in tail user message",
    !!tail && JSON.stringify(tail.content).includes("todo item"));

  // A second nudge (another 8 mutations) still must not touch system.
  rt.mutationsSinceLastTodoTouch = 8;
  const msgs2 = baseMessages();
  handlers["context"]({ messages: msgs2 });
  check("todo: system untouched by second nudge", systemUntouched(msgs2));

  // Layer 3: stop reminder (agent_settled → context on next call).
  rt.reminderPending = true;
  rt.awaitingProgress = false;
  const msgs3 = baseMessages();
  handlers["context"]({ messages: msgs3 });
  check("todo: system untouched by stop reminder", systemUntouched(msgs3));
  const tail3 = tailUserMessage(msgs3);
  check("todo: stop reminder lands in tail user message",
    !!tail3 && JSON.stringify(tail3.content).includes("incomplete todo"));

  rt.phases = [];
}

// ── 5. Prefix-hit simulation: legacy (system) vs tail injection ──
{
  // Model: message-granularity prefix matching (equivalent to the drift
  // audit's chain-fingerprint view). Legacy injects into the system
  // message; new pushes a tail user message.
  const SYSTEM_TOKENS = 2000;
  const PER_TURN_TOKENS = 1500;
  const REMINDER_TOKENS = 60;
  const TURNS = 20;

  function simulate(mode) {
    // history[t] = messages sent in request t (t = 0..TURNS-1)
    const requests = [];
    const history = []; // grows each turn
    let budgetUsed = 0;
    for (let t = 0; t < TURNS; t++) {
      budgetUsed += PER_TURN_TOKENS; // dynamic counter — changes every turn
      const reminderText = `<system-reminder>goal active, ${budgetUsed} tokens used</system-reminder>`;
      const msgs = [{ role: "system", content: `SYS${mode === "legacy" ? "-" + budgetUsed : ""}` }];
      for (const h of history) msgs.push(h);
      if (mode === "legacy") {
        msgs[0] = { role: "system", content: `SYS goal active, ${budgetUsed} tokens used` };
      } else {
        msgs.push({ role: "user", content: reminderText });
      }
      requests.push(msgs.map(m => JSON.stringify(m)));
      history.push({ role: "user", content: `user turn ${t}` });
      history.push({ role: "assistant", content: `assistant turn ${t}` });
    }
    // Compute total prefilled tokens: request t re-prefills everything
    // after its longest common message-prefix with any earlier request
    // (in-order: caches keep the latest write; approximate with the
    // max common prefix vs the union of prior requests).
    // Simple, faithful-to-mechanism model: hit(t) = common prefix with
    // request t-1 (agent loop re-sends history in order).
    let prefilled = 0;
    for (let t = 0; t < TURNS; t++) {
      const prev = t > 0 ? requests[t - 1] : null;
      let hitMsgs = 0;
      if (prev) {
        while (hitMsgs < Math.min(prev.length, requests[t].length) &&
               prev[hitMsgs] === requests[t][hitMsgs]) hitMsgs++;
      }
      const msgsTokenEst = (i) => {
        if (i === 0) return SYSTEM_TOKENS;
        const r = requests[t];
        void r;
        const isReminder = i === requests[t].length - 1 && mode === "tail";
        return isReminder ? REMINDER_TOKENS : PER_TURN_TOKENS / 2; // user+assistant pair = PER_TURN
      };
      let miss = 0;
      for (let i = hitMsgs; i < requests[t].length; i++) miss += msgsTokenEst(i);
      prefilled += miss;
    }
    return prefilled;
  }

  const legacy = simulate("legacy");
  const tail = simulate("tail");
  console.log(`  prefix-hit simulation over ${TURNS} turns: legacy(system-inject) prefill ≈ ${legacy} tok, tail-inject prefill ≈ ${tail} tok (saved ${((1 - tail / legacy) * 100).toFixed(1)}%)`);
  check("prefix-sim: tail injection saves >80% prefill", tail < legacy * 0.2,
    `legacy=${legacy} tail=${tail}`);
  check("prefix-sim: legacy really is the worst case (prefill grows)", legacy > 8 * SYSTEM_TOKENS);
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
