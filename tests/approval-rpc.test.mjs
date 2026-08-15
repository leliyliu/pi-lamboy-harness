// RPC approval dialog fallback tests (issue #4: approval silently
// auto-denied in RPC mode — "User denied: fallback-ask").
//
// Unit: approvalViaRpcUi decision paths over a mock extension UI ctx.
// Integration: harness wiring (mode !== "tui" → approvalViaRpcUi) with a
// manual-mode `ask` verdict — must reach the user via select/confirm
// instead of silently denying.
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
const { permissionManager } = loadTs(`${EXT}/packages/core/permission/index.ts`);
const { approvalViaRpcUi } = loadTs(`${EXT}/packages/core/permission/approval-rpc.ts`);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// Isolated env (same isolation as permission.test.mjs).
const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "approval-rpc-test-"));
process.env.KIMI_CODE_HOME = cleanCwd;
process.env.HOME = cleanCwd;
process.env.USERPROFILE = cleanCwd;

// ── Unit: approvalViaRpcUi ─────────────────────────────────────
const signal = new AbortController().signal;
const ctx = (ui) => ({ mode: "rpc", signal, ui });

let lastSelectOpts;
const rpcUi = {
  select: async (title, options, opts) => { lastSelectOpts = { title, options, opts }; return "Allow once"; },
  confirm: async () => true,
  input: async () => "because the test says so",
};
const call = (ui, tool = "edit", title = "Title", message = "msg") =>
  approvalViaRpcUi(ctx(ui), tool, title, message);

{
  const r = await call(rpcUi);
  check("unit: 'Allow once' → decision once", r?.decision === "once", JSON.stringify(r));
  check("unit: select prompt is '<title>: <message>'", lastSelectOpts.title === "Title: msg", lastSelectOpts.title);
  check("unit: select offers 4 options (once/always/deny/deny-with-reason)",
    Array.isArray(lastSelectOpts.options) && lastSelectOpts.options.length === 4 &&
    lastSelectOpts.options[0] === "Allow once" && lastSelectOpts.options[2] === "Deny",
    JSON.stringify(lastSelectOpts.options));
  check("unit: abort signal passed to select", lastSelectOpts.opts?.signal === signal, JSON.stringify(lastSelectOpts.opts));
}

{
  const r = await call({ ...rpcUi, select: async () => "Always allow (this session)" });
  check("unit: 'Always allow' → decision always", r?.decision === "always", JSON.stringify(r));
}
{
  const r = await call({ ...rpcUi, select: async () => "Deny" });
  check("unit: 'Deny' → decision deny", r?.decision === "deny", JSON.stringify(r));
}
{
  const r = await call({ ...rpcUi, select: async () => undefined });
  check("unit: cancelled select (undefined) → deny", r?.decision === "deny", JSON.stringify(r));
}
{
  let inputCalls = 0;
  const r = await call({
    ...rpcUi,
    select: async () => "Deny with reason",
    input: async () => { inputCalls++; return "do not touch prod"; },
  });
  check("unit: 'Deny with reason' + reason → deny with reason",
    r?.decision === "deny" && r?.reason === "do not touch prod", JSON.stringify(r));
  check("unit: deny reason prompt shown once", inputCalls === 1, String(inputCalls));
}
{
  // Esc in the reason input → back to the options (TUI parity).
  let selectCalls = 0;
  const r = await call({
    ...rpcUi,
    select: async () => { selectCalls++; return selectCalls === 1 ? "Deny with reason" : "Allow once"; },
    input: async () => undefined,
  });
  check("unit: cancelled reason input re-selects, second choice wins",
    r?.decision === "once" && selectCalls === 2, `${JSON.stringify(r)} selects=${selectCalls}`);
}
{
  const r = await call({ ...rpcUi, select: async () => "Deny with reason", input: async () => { throw new Error("no input"); } });
  check("unit: input throws → fail-safe deny", r?.decision === "deny", JSON.stringify(r));
}
{
  const r = await call({ ...rpcUi, select: async () => { throw new Error("host failure"); } });
  check("unit: select throws → fail-safe deny", r?.decision === "deny", JSON.stringify(r));
}
{
  // Host without select: boolean confirm as last resort.
  let confirmCalls = 0;
  const uiNoSelect = {
    confirm: async (t, m) => { confirmCalls++; check("unit: confirm fallback gets tool name", m === "Tool: edit", m); return true; },
  };
  const r = await call(uiNoSelect);
  check("unit: no select + confirm true → once", r?.decision === "once" && confirmCalls === 1, JSON.stringify(r));
  const r2 = await call({ ...uiNoSelect, confirm: async () => false });
  check("unit: no select + confirm false → deny", r2?.decision === "deny", JSON.stringify(r2));
}
{
  const r = await call({ confirm: async () => { throw new Error("broken"); } });
  check("unit: no select + confirm throws → deny", r?.decision === "deny", JSON.stringify(r));
}
{
  const r = await call(undefined);
  check("unit: no ui at all → deny (fail-safe)", r?.decision === "deny", JSON.stringify(r));
}

// ── Integration: harness wiring fixes issue #4 ─────────────────
// Wire exactly like index.ts: non-TUI modes route to approvalViaRpcUi.
permissionManager.setApprovalDialog(async (dialogCtx, toolName, title, message) => {
  if (dialogCtx?.mode !== "tui") return approvalViaRpcUi(dialogCtx, toolName, `${title}`, message);
  return { decision: "deny" };
});

function makeRpcCtx(ui) {
  return {
    mode: "rpc",
    hasUI: true,
    sessionId: "approval-rpc-session",
    ui,
  };
}
const evalRpc = (tool, input, ui) =>
  permissionManager.evaluate(tool, input, cleanCwd, makeRpcCtx(ui));

// manual mode + destructive bash → `ask` verdict; must now reach select().
permissionManager.resetHistory();
permissionManager.setMode("manual");
{
  const r = await evalRpc("bash", { command: "rm -rf /tmp/approval-rpc-x" }, {
    select: async () => "Allow once",
    confirm: async () => false,
  });
  check("integration: RPC manual-mode ask + 'Allow once' → allowed (was: silent deny)",
    r === undefined, JSON.stringify(r));
}
{
  const r = await evalRpc("bash", { command: "rm -rf /tmp/approval-rpc-y" }, {
    select: async () => "Deny",
    confirm: async () => false,
  });
  check("integration: RPC ask + 'Deny' → blocked with User denied",
    r?.block === true && /User denied/.test(r?.reason ?? ""), JSON.stringify(r));
}
{
  // pi rpc-mode ships a `custom` stub that resolves undefined — routing must
  // key on mode, not on custom's presence, or the stub re-introduces the bug.
  // (rm -rf triggers two ask verdicts: destructive-command-ask + fallback-ask.)
  let selectCalls = 0;
  const r = await evalRpc("bash", { command: "rm -rf /tmp/approval-rpc-z" }, {
    custom: async () => undefined, // exactly pi's rpc-mode stub
    select: async () => { selectCalls++; return "Allow once"; },
    confirm: async () => false,
  });
  check("integration: custom stub present (pi rpc-mode) still routes to select",
    r === undefined && selectCalls === 2, `${JSON.stringify(r)} selects=${selectCalls}`);
}
{
  // Host with only confirm (minimal RPC host): boolean approve works too.
  const r = await evalRpc("bash", { command: "rm -rf /tmp/approval-rpc-w" }, {
    confirm: async () => true,
  });
  check("integration: select-less RPC host falls back to confirm → allowed",
    r === undefined, JSON.stringify(r));
}

permissionManager.setMode("manual");
permissionManager.resetHistory();
fs.rmSync(cleanCwd, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
