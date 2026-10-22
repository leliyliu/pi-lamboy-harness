// Attention event layer tests (pure, no pi runtime, no model quota).
//
// Covers the cross-extension "user is now blocked on a dialog" signal that
// ask_user_question / permission approval / plan review emit over
// pi.events ("lamboy:attention"), plus the three integration call sites and
// the personal notify extension wiring. TS loading strategy matches
// tests/permission.test.mjs (jiti transform + shared module cache).
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
const attention = loadTs(`${EXT}/packages/core/attention/index.ts`);
const received = [];
const seen = (kind) => received.filter((r) => r.kind === kind);

/** Reset dedupe + bind a fake pi.events bus; returns the delivery log. */
function bindBus(overrides = {}) {
  attention.resetAttentionState();
  attention.setAttentionBus({
    emit: (channel, data) => received.push({ channel, ...data }),
    ...overrides,
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. No bus bound → silent no-op ─────────────────────────────────────────
attention.resetAttentionState();
{
  let threw = false;
  let delivered;
  try {
    delivered = attention.emitAttention({ kind: "ask", title: "t", body: "b" });
  } catch { threw = true; }
  check("no bus: emitAttention does not throw", threw === false);
  check("no bus: reports not delivered", delivered === false, String(delivered));
}

// ── 2. Bound bus receives one event on the documented channel ─────────────
bindBus();
{
  const ok = attention.emitAttention({ kind: "ask", title: "❓ 需要你回答", body: "Q?", mode: "tui" });
  check("bus: emit reports delivered", ok === true);
  check("bus: one event per emit", received.length === 1, JSON.stringify(received));
  check("bus: channel is lamboy:attention", received[0]?.channel === "lamboy:attention", received[0]?.channel);
  check("bus: payload kind", received[0]?.kind === "ask");
  check("bus: payload title", received[0]?.title === "❓ 需要你回答");
  check("bus: payload body", received[0]?.body === "Q?");
}

// ── 3. Fail-open: a throwing bus must never break the dialog ───────────────
attention.resetAttentionState();
attention.setAttentionBus({ emit: () => { throw new Error("boom"); } });
{
  let threw = false;
  let delivered;
  try {
    delivered = attention.emitAttention({ kind: "approval", title: "t", body: "b", mode: "tui" });
  } catch { threw = true; }
  check("fail-open: throwing bus does not propagate", threw === false);
  check("fail-open: throwing bus reported as not delivered", delivered === false);
  bindBus();
  const ok = attention.emitAttention({ kind: "plan", title: "t", body: "b", mode: "tui" });
  check("fail-open: later events still delivered", ok === true && seen("plan").length === 1);
}

// ── 4. Mode gating: non-TUI hosts stay silent ──────────────────────────────
bindBus();
{
  const before = seen("ask").length;
  const rpc = attention.emitAttention({ kind: "ask", title: "t", body: "b", mode: "rpc" });
  check("mode gate: rpc not delivered", rpc === false && seen("ask").length === before);
  const tui = attention.emitAttention({ kind: "ask", title: "t", body: "b", mode: "tui" });
  check("mode gate: tui delivered", tui === true && seen("ask").length === before + 1);
  const legacy = attention.emitAttention({ kind: "plan", title: "t2", body: "b2" });
  check("mode gate: undefined mode treated as interactive", legacy === true);
}

// ── 5. Dedupe: same kind within the window collapses, different kinds do not
bindBus();
{
  const firstApproval = attention.emitAttention({ kind: "approval", title: "a", body: "1", mode: "tui" });
  const secondApproval = attention.emitAttention({ kind: "approval", title: "a", body: "2", mode: "tui" });
  check("dedupe: first approval delivered", firstApproval === true);
  check("dedupe: immediate repeat suppressed", secondApproval === false);
  check("dedupe: suppressed event never reached the bus", seen("approval").length === 1, JSON.stringify(seen("approval")));

  const askDuringWindow = attention.emitAttention({ kind: "ask", title: "q", body: "3", mode: "tui" });
  check("dedupe: other kinds unaffected", askDuringWindow === true);

  await sleep(attention.ATTENTION_DEDUPE_MS + 60);
  const afterWindow = attention.emitAttention({ kind: "approval", title: "a", body: "4", mode: "tui" });
  check("dedupe: window expiry re-delivers", afterWindow === true);
}

// ── 6. Unbinding clears delivery ──────────────────────────────────────────
bindBus();
attention.setAttentionBus(null);
{
  const ok = attention.emitAttention({ kind: "ask", title: "t", body: "b", mode: "tui" });
  check("unbind: no delivery", ok === false);
}

// ── 7. Permission ask branch emits exactly one approval event ──────────────
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "attention-home-"));
process.env.USERPROFILE = process.env.HOME;
const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "attention-cwd-"));
const { permissionManager } = loadTs(`${EXT}/packages/core/permission/index.ts`);
permissionManager.setMode("manual");
permissionManager.resetHistory();
bindBus();
permissionManager.setApprovalDialog(async () => ({ decision: "deny" }));
{
  const before = seen("approval").length;
  const blocked = await permissionManager.evaluate(
    "bash", { command: "echo attention-probe" }, cleanCwd,
    { hasUI: true, mode: "tui", sessionId: "attention-session", ui: {} },
  );
  check("permission ask: denied by fake dialog", blocked?.block === true, JSON.stringify(blocked));
  const got = seen("approval");
  check("permission ask: one approval event emitted", got.length === before + 1, JSON.stringify(got));
  check("permission ask: body names the tool", /bash/.test(got[before]?.body ?? ""), got[before]?.body);
  check("permission ask: title signals approval", /授权/.test(got[before]?.title ?? ""), got[before]?.title);
}

// Non-interactive (no UI) deny path must NOT ask → no notification.
{
  const before = seen("approval").length;
  const blocked = await permissionManager.evaluate(
    "edit", { path: "src/app.ts" }, cleanCwd,
    { hasUI: false, mode: "tui", sessionId: "attention-session", ui: {} },
  );
  check("permission no-UI: still blocked", blocked?.block === true);
  check("permission no-UI: zero approval events", seen("approval").length === before);
}

// Declarative deny (no dialog) must NOT notify.
permissionManager.setMode("auto");
{
  const before = seen("approval").length;
  await permissionManager.evaluate(
    "ask_user_question", { question: "Should I?" }, cleanCwd,
    { hasUI: true, mode: "tui", sessionId: "attention-session", ui: {} },
  );
  check("permission deny policy: zero approval events", seen("approval").length === before);
}
permissionManager.setMode("manual");
permissionManager.resetHistory();

// ── 8. ask_user_question emits one ask event when the dialog opens ─────────
const askModule = loadTs(`${EXT}/ask/index.ts`);
let askTool;
askModule.registerAskUserQuestion({ registerTool: (t) => { askTool = t; } });
check("ask: tool registered", askTool?.name === "ask_user_question");

bindBus();
{
  const before = seen("ask").length;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: { custom: async () => ({ cancelled: true, states: [] }) },
  };
  const res = await askTool.execute("call-1", { question: "Which approach?", options: ["A", "B"] }, null, null, ctx);
  check("ask: dialog result returned", typeof res?.content?.[0]?.text === "string");
  const got = seen("ask");
  check("ask: one ask event emitted", got.length === before + 1, JSON.stringify(got));
  check("ask: body carries the question", /Which approach\?/.test(got[before]?.body ?? ""), got[before]?.body);
}

// The shared dialog helper (reused by permission approval) must never emit —
// otherwise permission approval would notify twice.
{
  const before = seen("ask").length;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: { custom: async () => ({ cancelled: true, states: [] }) },
  };
  await askModule.showQuestionsDialog(ctx, [{ question: "Direct dialog?", options: ["A", "B"] }]);
  check("shared dialog: showQuestionsDialog itself never emits", seen("ask").length === before);
}

// No UI → text fallback, no notification.
{
  const before = seen("ask").length;
  const ctx = { hasUI: false, mode: "tui", ui: {} };
  const res = await askTool.execute("call-2", { question: "Which approach?", options: ["A", "B"] }, null, null, ctx);
  check("ask no-UI: text fallback", /Interactive UI is not available/.test(res?.content?.[0]?.text ?? ""));
  check("ask no-UI: zero ask events", seen("ask").length === before);
}

// ── 9. exit_plan_mode emits one plan event before the review panel ────────
const { registerPlanTools } = loadTs(`${EXT}/packages/core/plan/tools.ts`);
const { planManager } = loadTs(`${EXT}/packages/core/plan/index.ts`);
planManager.setSessionDir(cleanCwd);
const tools = new Map();
registerPlanTools({ registerTool: (t) => tools.set(t.name, t) }, planManager);
check("plan: exit tool registered", tools.has("exit_plan_mode"));

bindBus();
{
  const enterCtx = {
    mode: "tui",
    ui: { notify() {}, setStatus() {}, theme: { fg: (_c, s) => s } },
  };
  await tools.get("enter_plan_mode").execute("call-3", {}, null, null, enterCtx);

  const before = seen("plan").length;
  const reviewCtx = {
    mode: "tui",
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_c, s) => s },
      select: async () => "Approve",
      input: async () => "",
    },
  };
  const res = await tools.get("exit_plan_mode").execute("call-4", {}, null, null, reviewCtx);
  check("plan: approved via review panel", /approved/i.test(res?.content?.[0]?.text ?? ""), res?.content?.[0]?.text);
  const got = seen("plan");
  check("plan: one plan event emitted", got.length === before + 1, JSON.stringify(got));
  check("plan: title signals review", /计划/.test(got[before]?.title ?? ""), got[before]?.title);
}

// Auto-approved plans skip the panel → no plan event.
{
  permissionManager.setMode("auto");
  planManager.enterPlanMode("attention-auto");
  bindBus();
  const before = seen("plan").length;
  const autoCtx = {
    mode: "tui",
    ui: { notify() {}, setStatus() {}, theme: { fg: (_c, s) => s } },
  };
  await tools.get("exit_plan_mode").execute("call-5", {}, null, null, autoCtx);
  check("plan auto-approve: zero plan events", seen("plan").length === before);
  permissionManager.setMode("manual");
}

// ── 10. personal notify extension subscribes to the attention channel ─────
const notifyFactory = loadTs(`${EXT}/personal/extensions/notify.ts`).default;
{
  const subscriptions = [];
  const handlers = new Map();
  let unsubscribed = 0;
  const fakePi = {
    events: { on: (channel, handler) => { subscriptions.push({ channel, handler }); return () => { unsubscribed++; }; } },
    on: (event, handler) => { handlers.set(event, handler); },
  };
  notifyFactory(fakePi);
  check("notify: subscribes to lamboy:attention",
    subscriptions.length === 1 && subscriptions[0]?.channel === "lamboy:attention",
    JSON.stringify(subscriptions.map((s) => s.channel)));
  check("notify: attention handler is callable", typeof subscriptions[0]?.handler === "function");
  check("notify: keeps agent_settled handler", handlers.has("agent_settled"));
  check("notify: keeps message_end handler", handlers.has("message_end"));

  const shutdown = handlers.get("session_shutdown");
  check("notify: registers session_shutdown cleanup", typeof shutdown === "function");
  if (typeof shutdown === "function") {
    await shutdown();
    check("notify: shutdown unsubscribes", unsubscribed === 1, String(unsubscribed));
  }
}

attention.setAttentionBus(null);
fs.rmSync(cleanCwd, { recursive: true, force: true });
fs.rmSync(process.env.HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
