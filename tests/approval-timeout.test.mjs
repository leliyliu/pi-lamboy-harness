// Approval idle timeout — 人不在时阻塞面板超时自动推进。
// Pure node tests (no pi runtime, no model quota): jiti-compiled TS with a
// single shared module cache (cross-module state: sessionApprovals,
// timeoutSessionOverride container).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { jitiUrl } from "./jiti-path.mjs";
const { createJiti } = await import(jitiUrl());
const jiti = createJiti(import.meta.url, { moduleCache: false });
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

// The timeout timers are unref()'d so they never keep a real CLI alive;
// this test process needs its own keep-alive to await them.
const keepAlive = setInterval(() => {}, 250);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// Isolate HOME (no real permissions.json / AGENTS.md) and machine env overrides.
const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-test-home-"));
process.env.HOME = cleanHome;
process.env.USERPROFILE = cleanHome;
delete process.env.PI_APPROVAL_TIMEOUT_MS;
delete process.env.PI_DESTRUCTIVE_TIMEOUT_MS;

const { permissionManager } = loadTs(`${EXT}/packages/core/permission/index.ts`);
const { sessionApprovals } = loadTs(`${EXT}/packages/core/permission/types.ts`);
const timeoutMod = loadTs(`${EXT}/packages/core/permission/timeout.ts`);
const {
  loadApprovalTimeoutConfig,
  approvalTimeoutFor,
  setSessionTimeoutOverride,
  formatDuration,
  runDialogWithTimeout,
  APPROVAL_TIMEOUT_DEFAULTS,
} = timeoutMod;
const { askViaDialog } = { askViaDialog: null }; // placeholder-free: ask tool is exercised below
void askViaDialog;

const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-test-cwd-"));

// ── 1. Config defaults ──────────────────────────────────────────────────────
{
  const cfg = loadApprovalTimeoutConfig(cleanCwd);
  check("defaults: enabled", cfg.enabled === true);
  check("defaults: yolo + auto only",
    cfg.modes.length === 2 && cfg.modes.includes("yolo") && cfg.modes.includes("auto"),
    JSON.stringify(cfg.modes));
  check("defaults: 5min normal / 15min destructive",
    cfg.defaultMs === 300000 && cfg.destructiveMs === 900000,
    `${cfg.defaultMs}/${cfg.destructiveMs}`);
  check("defaults constants exported", APPROVAL_TIMEOUT_DEFAULTS.defaultMs === 300000);
}

// ── 2. permissions.json override (global) ──────────────────────────────────
const globalDir = path.join(cleanHome, ".pi", "agent");
fs.mkdirSync(globalDir, { recursive: true });
{
  fs.writeFileSync(path.join(globalDir, "permissions.json"), JSON.stringify({
    approvalTimeout: { defaultMs: 1000, destructiveMs: 2000, modes: ["yolo"] },
  }));
  const cfg = loadApprovalTimeoutConfig(cleanCwd);
  check("json: defaultMs honoured", cfg.defaultMs === 1000, String(cfg.defaultMs));
  check("json: destructiveMs honoured", cfg.destructiveMs === 2000, String(cfg.destructiveMs));
  check("json: modes narrowed to yolo", cfg.modes.length === 1 && cfg.modes[0] === "yolo");

  // Project-level file overrides the global one (read after it).
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-test-proj-"));
  fs.mkdirSync(path.join(projDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projDir, ".pi", "permissions.json"), JSON.stringify({
    approvalTimeout: { defaultMs: 3000 },
  }));
  const projCfg = loadApprovalTimeoutConfig(projDir);
  check("json: project defaultMs overrides global", projCfg.defaultMs === 3000, String(projCfg.defaultMs));

  // enabled:false kills it entirely.
  fs.writeFileSync(path.join(globalDir, "permissions.json"), JSON.stringify({
    approvalTimeout: { enabled: false },
  }));
  check("json: enabled=false disables", loadApprovalTimeoutConfig(cleanCwd).enabled === false);
}

// ── 3. Env overrides ───────────────────────────────────────────────────────
{
  fs.rmSync(path.join(globalDir, "permissions.json"), { force: true });
  process.env.PI_APPROVAL_TIMEOUT_MS = "1234";
  process.env.PI_DESTRUCTIVE_TIMEOUT_MS = "5678";
  const cfg = loadApprovalTimeoutConfig(cleanCwd);
  check("env: PI_APPROVAL_TIMEOUT_MS", cfg.defaultMs === 1234, String(cfg.defaultMs));
  check("env: PI_DESTRUCTIVE_TIMEOUT_MS", cfg.destructiveMs === 5678, String(cfg.destructiveMs));
  delete process.env.PI_APPROVAL_TIMEOUT_MS;
  delete process.env.PI_DESTRUCTIVE_TIMEOUT_MS;
}

// ── 4. Target + mode gating ────────────────────────────────────────────────
{
  check("gating: manual never times out", approvalTimeoutFor("approval", "manual") === undefined);
  check("gating: yolo approval → defaultMs", approvalTimeoutFor("approval", "yolo") === 300000);
  check("gating: yolo destructive → destructiveMs",
    approvalTimeoutFor("approval-destructive", "yolo") === 900000);
  check("gating: auto covered too", approvalTimeoutFor("plan", "auto") === 300000);
  check("gating: ask tool uses defaultMs", approvalTimeoutFor("ask", "yolo") === 300000);

  setSessionTimeoutOverride(0);
  check("override: 0 disables", approvalTimeoutFor("approval", "yolo") === undefined);
  setSessionTimeoutOverride(45000);
  check("override: ms wins over config", approvalTimeoutFor("approval-destructive", "yolo") === 45000);
  setSessionTimeoutOverride(null);
  check("override: null restores config", approvalTimeoutFor("approval", "yolo") === 300000);
}

// ── 5. formatDuration ──────────────────────────────────────────────────────
{
  check("formatDuration 300000 → 5m00s", formatDuration(300000) === "5m00s", formatDuration(300000));
  check("formatDuration 45000 → 45s", formatDuration(45000) === "45s", formatDuration(45000));
  check("formatDuration 900000 → 15m00s", formatDuration(900000) === "15m00s", formatDuration(900000));
}

// ── 6. runDialogWithTimeout: timeout vs Esc must differ ────────────────────
{
  const t0 = Date.now();
  const timed = await runDialogWithTimeout(
    ({ signal }) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
    40,
  );
  const elapsed = Date.now() - t0;
  check("dialog timeout: flagged timedOut", timed.timedOut === true && timed.value === undefined);
  check("dialog timeout: waited for the window", elapsed >= 30, `${elapsed}ms`);

  const esc = await runDialogWithTimeout(async () => undefined, 40);
  check("dialog Esc: not a timeout", esc.timedOut === false && esc.value === undefined);

  const fast = await runDialogWithTimeout(async () => "Allow once", 40);
  check("dialog answer: value kept, no timeout", fast.timedOut === false && fast.value === "Allow once");
}

// ── 7. permission evaluate: destructive timeout → allow once, no memory ────
const makeCtx = (overrides = {}) => ({
  hasUI: true,
  mode: "tui",
  sessionId: "timeout-test-session",
  ui: { confirm: async () => false, notify: () => {}, ...overrides },
});

{
  permissionManager.resetHistory();
  permissionManager.setMode("yolo");
  let seenOpts;
  permissionManager.setApprovalDialog(async (_ctx, _tool, _title, _msg, opts) => {
    seenOpts = opts;
    return { decision: "once", timedOut: true };
  });

  const started = Date.now();
  const result = await permissionManager.evaluate(
    "bash", { command: "rm -rf /tmp/timeout-probe" }, cleanCwd, makeCtx(),
  );
  const elapsed = Date.now() - started;

  check("yolo+timeout: destructive call allowed", result === undefined, JSON.stringify(result));
  check("yolo+timeout: dialog got the destructive window",
    seenOpts?.timeoutMs === 900000 && seenOpts?.isDestructive === true, JSON.stringify(seenOpts));
  check("yolo+timeout: no real waiting (fake dialog)", elapsed < 1000, `${elapsed}ms`);

  const approvals = sessionApprovals.get("timeout-test-session");
  const fingerprint = 'bash:rm -rf /tmp/timeout-probe';
  check("yolo+timeout: allow-once is NOT memoized",
    !(approvals && approvals.has(fingerprint)), approvals ? [...approvals].join(",") : "no history");

  const messages = [];
  permissionManager.injectIntoMessages(messages);
  const injected = messages.map((m) => m.content?.[0]?.text ?? "").join("\n");
  check("yolo+timeout: model told it was not reviewed",
    injected.includes("Idle-timeout auto-approval") && injected.includes("not reviewed by the user"),
    injected.slice(-300));
  check("yolo+timeout: destructive flag + command relayed",
    injected.includes("DESTRUCTIVE") && injected.includes("rm -rf /tmp/timeout-probe"),
    injected.slice(-300));
  check("yolo+timeout: notice drained (injected once)",
    permissionManager.drainTimeoutNotices().length === 0);
}

// ── 8. permission evaluate: a real answer is still memoized ────────────────
{
  permissionManager.resetHistory();
  permissionManager.setMode("yolo");
  permissionManager.setApprovalDialog(async () => ({ decision: "once" }));

  const result = await permissionManager.evaluate(
    "read", { path: ".env" }, cleanCwd, makeCtx(),
  );
  check("yolo: sensitive-file ask allowed by user", result === undefined, JSON.stringify(result));
  const approvals = sessionApprovals.get("timeout-test-session");
  check("yolo: 'Allow once' still recorded in session history",
    Boolean(approvals?.has('read:{"path":".env"}')), approvals ? [...approvals].join(",") : "no history");
  check("yolo: no timeout notice for a real answer", permissionManager.drainTimeoutNotices().length === 0);
}

// ── 9. mode gating end-to-end: manual never gets a timeout ─────────────────
{
  permissionManager.resetHistory();
  permissionManager.setMode("manual");
  let seenOpts;
  permissionManager.setApprovalDialog(async (_ctx, _tool, _title, _msg, opts) => {
    seenOpts = opts;
    return { decision: "deny" };
  });
  const blocked = await permissionManager.evaluate("read", { path: ".env" }, cleanCwd, makeCtx());
  check("manual: dialog gets no timeout", seenOpts?.timeoutMs === undefined, JSON.stringify(seenOpts));
  check("manual: deny still blocks", blocked?.block === true);
}

// ── 10. dialog component: countdown renders + closes as timedOut ───────────
{
  const { showQuestionDialogOutcome } = loadTs(`${EXT}/ask/index.ts`);
  let component;
  const fakeCtx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: (factory) => new Promise((resolve) => {
        component = factory({ requestRender: () => {} }, { fg: (_c, s) => s, bold: (s) => s }, {}, resolve);
      }),
    },
  };
  const spec = { question: "Approve?", options: [{ label: "Allow once" }, { label: "Deny" }] };

  const pending = showQuestionDialogOutcome(fakeCtx, spec, { timeoutMs: 60, countdownLabel: "auto-allow" });
  await new Promise((r) => setTimeout(r, 20));
  const rendered = component.render(100).join("\n");
  check("dialog: countdown row rendered", rendered.includes("⏰") && rendered.includes("auto-allow"), rendered.slice(-200));

  const outcome = await pending;
  check("dialog: closes as timedOut", outcome.timedOut === true && outcome.unavailable === false,
    JSON.stringify(outcome));
  check("dialog: component disposed cleanly", (component.dispose(), true));
}

// ── 11. ask_user_question tool: timeout unblocks the model ────────────────
{
  const { registerAskUserQuestion } = loadTs(`${EXT}/ask/index.ts`);
  let tool;
  registerAskUserQuestion({ registerTool: (t) => { tool = t; } });
  check("ask tool registered", Boolean(tool));

  permissionManager.setMode("yolo");
  setSessionTimeoutOverride(60);
  const fakeCtx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: (factory) => new Promise((resolve) => {
        factory({ requestRender: () => {} }, { fg: (_c, s) => s, bold: (s) => s }, {}, resolve);
      }),
    },
  };
  const toolResult = await tool.execute(
    "call-1", { question: "Which route?", options: ["A", "B"] }, undefined, undefined, fakeCtx,
  );
  const text = toolResult.content?.[0]?.text ?? "";
  check("ask tool: tells the model nobody answered",
    text.includes("No answer within") && text.includes("Decide yourself"), text.slice(0, 200));
  check("ask tool: details flag", toolResult.details?.timedOut === true);
  setSessionTimeoutOverride(null);

  // Sanity: with the timeout disabled the dialog stays blocking (no timeout flag).
  permissionManager.setMode("manual");
  const blocking = tool.execute("call-2", { question: "Which route?", options: ["A", "B"] }, undefined, undefined, {
    hasUI: true,
    mode: "tui",
    ui: { custom: (factory) => new Promise((resolve) => {
      const comp = factory({ requestRender: () => {} }, { fg: (_c, s) => s, bold: (s) => s }, {}, resolve);
      setTimeout(() => { comp.handleInput("\r"); }, 20); // user answers interactively
    }) },
  });
  const answered = await blocking;
  check("ask tool: manual mode has no timeout (real answer path)",
    (answered.content?.[0]?.text ?? "").includes("A"), (answered.content?.[0]?.text ?? "").slice(0, 120));
}

// ── 12. Regression (reviewer B1): non-destructive timeout must NOT memoize ──
// yolo + user ask rule: timeout allow → later yolo-approve fires and must not
// write session history, otherwise the next identical call is silently allowed
// and the panel never reappears.
{
  const ruleCwd = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-test-rule-"));
  fs.mkdirSync(path.join(ruleCwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(ruleCwd, ".pi", "permissions.json"),
    JSON.stringify({ ask: ["bash"] }),
  );

  permissionManager.resetHistory();
  permissionManager.setMode("yolo");
  let dialogCalls = 0;
  permissionManager.setApprovalDialog(async () => {
    dialogCalls++;
    return { decision: "once", timedOut: true };
  });

  const first = await permissionManager.evaluate("bash", { command: "echo hi" }, ruleCwd, makeCtx());
  check("B1: user-ask timeout is allowed", first === undefined, JSON.stringify(first));
  const approvals = sessionApprovals.get("timeout-test-session");
  check("B1: non-destructive timeout is NOT memoized",
    !(approvals && approvals.has("bash:echo hi")),
    approvals ? [...approvals].join(",") : "no history");

  permissionManager.injectIntoMessages([]); // drain the timeout note
  const second = await permissionManager.evaluate("bash", { command: "echo hi" }, ruleCwd, makeCtx());
  check("B1: same call still asks (panel reappears)", dialogCalls === 2 && second === undefined,
    `dialogCalls=${dialogCalls}`);

  fs.rmSync(ruleCwd, { recursive: true, force: true });
}

// ── 13. Regression (reviewer M1): confirm() abort is a timeout, not a deny ─
{
  permissionManager.resetHistory();
  permissionManager.setMode("yolo");
  permissionManager.setApprovalDialog(null); // exercise the ctx.ui.confirm fallback
  setSessionTimeoutOverride(60);

  // pi's confirm resolves false when the dialog is dismissed by an abort
  // (interactive-mode.js: `return result === "Yes"`).
  const abortableCtx = makeCtx({
    confirm: (_title, _msg, opts) => new Promise((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
    }),
  });
  const timedOutCall = await permissionManager.evaluate("read", { path: ".env" }, cleanCwd, abortableCtx);
  check("M1: confirm-abort timeout is allowed, not denied",
    timedOutCall === undefined, JSON.stringify(timedOutCall));

  const messages = [];
  permissionManager.injectIntoMessages(messages);
  check("M1: confirm-abort records a timeout notice",
    messages.map((m) => m.content?.[0]?.text ?? "").join("\n").includes("Idle-timeout auto-approval"));

  // Esc (no abort from our timer) must still deny.
  permissionManager.resetHistory();
  permissionManager.setApprovalDialog(null);
  const escCtx = makeCtx({ confirm: async () => false });
  const denied = await permissionManager.evaluate("read", { path: ".env" }, cleanCwd, escCtx);
  check("M1: Esc still denies", denied?.block === true, JSON.stringify(denied));
  setSessionTimeoutOverride(null);
}

fs.rmSync(cleanHome, { recursive: true, force: true });
fs.rmSync(cleanCwd, { recursive: true, force: true });
clearInterval(keepAlive);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
