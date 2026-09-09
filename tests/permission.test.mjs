// Permission policy chain unit tests (pure, no pi runtime, no model quota).
// TS is transformed by pi's bundled jiti (extensionless relative imports
// cannot be loaded by node --experimental-strip-types). jiti.import/jiti()
// exhibit stale-namespace behavior for cross-module `export let` state
// (jiti 2.7.0), so evaluation uses a small local CJS loader around
// jiti.transform with a single shared module cache.
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

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// Isolated cwd (no AGENTS.md / .pi/permissions.json anywhere up its tree).
const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-clean-"));

// Isolate from the machine's real global instruction files: the policy chain
// honors ~/.agents/AGENTS.md (cross-tool), so point HOME at the empty temp
// dir unless a test overrides one deliberately.
process.env.HOME = cleanCwd;
process.env.USERPROFILE = cleanCwd;

// ctx stub: confirmAnswer controls the simulated user's choice on ask prompts.
function makeCtx(confirmAnswer) {
  return {
    hasUI: true,
    sessionId: "perm-test-session",
    ui: { confirm: async () => confirmAnswer },
  };
}

const evalIn = (tool, input, cwd, approve) =>
  permissionManager.evaluate(tool, input, cwd, makeCtx(approve));

// ── 1. auto 模式: write .env 先触发敏感文件 ask（用户拒绝 → block）──────────
permissionManager.resetHistory();
permissionManager.setMode("auto");
{
  const blocked = await evalIn("write", { path: ".env", content: "SECRET=1" }, cleanCwd, false);
  check("auto: write .env asks before auto-approve (denied => block)", blocked?.block === true, JSON.stringify(blocked));
}

// ── 2. auto 模式: bash rm -rf 先触发破坏性 ask（用户拒绝 → block）────────────
{
  const blocked = await evalIn("bash", { command: "rm -rf /tmp/x" }, cleanCwd, false);
  check("auto: bash 'rm -rf' asks before auto-approve (denied => block)", blocked?.block === true, JSON.stringify(blocked));
}

// ── 2b. auto 模式: AskUserQuestion 必须被拒绝 ───────────────────────────────
{
  const blocked = await evalIn("ask_user_question", { question: "Should I?" }, cleanCwd, false);
  check("auto: ask_user_question is denied in auto mode", blocked?.block === true, JSON.stringify(blocked));
}

// ── 3. 批准过 bash ls 之后, rm -rf 仍必须问(destructive 不被 sessionApprovals 短路)
permissionManager.resetHistory();
permissionManager.setMode("manual");
{
  const first = await evalIn("bash", { command: "ls -la /tmp/perm-probe" }, cleanCwd, true);
  check("manual: bash ls approved when user confirms", first === undefined, JSON.stringify(first));

  const blocked = await evalIn("bash", { command: "rm -rf /tmp/x" }, cleanCwd, false);
  check("manual: rm -rf still asks after unrelated approval", blocked?.block === true, JSON.stringify(blocked));

  // Even if the user says YES to the destructive ask, it must NOT be cached:
  // the next identical destructive command must ask again.
  const approvedOnce = await evalIn("bash", { command: "rm -rf /tmp/y" }, cleanCwd, true);
  check("manual: destructive approved when user explicitly confirms", approvedOnce === undefined, JSON.stringify(approvedOnce));
  const blockedAgain = await evalIn("bash", { command: "rm -rf /tmp/y" }, cleanCwd, false);
  check("manual: same destructive command is never short-circuited by history", blockedAgain?.block === true, JSON.stringify(blockedAgain));
}

// ── 4. 同指纹的重复操作在 manual 模式第二次被会话批准短路 ─────────────────
permissionManager.resetHistory();
{
  // First call: user confirms -> recorded under input fingerprint.
  await evalIn("bash", { command: "make build" }, cleanCwd, true);
  // Second call: user would DENY, but session history must short-circuit.
  const second = await evalIn("bash", { command: "make build" }, cleanCwd, false);
  check("manual: same-fingerprint repeat approved via session history", second === undefined, JSON.stringify(second));
}

// ── 5. AGENTS.md 含 destructive-ask-always 时 destructive -> deny ─────────
{
  const denyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-deny-"));
  fs.writeFileSync(path.join(denyCwd, "AGENTS.md"), "# Directives\n\ndestructive-ask-always\n");
  // Even with the user willing to approve, the directive denies outright.
  const blocked = await evalIn("bash", { command: "rm -rf /tmp/z" }, denyCwd, true);
  check("agentsMd destructive-ask-always: destructive denied (not asked)",
    blocked?.block === true && /destructive-ask-always/.test(blocked?.reason ?? ""),
    JSON.stringify(blocked));
  fs.rmSync(denyCwd, { recursive: true, force: true });
}

// ── 5b. 跨工具全局 ~/.agents/AGENTS.md 的 destructive-ask-always 同样生效 ──
{
  const agentsHome = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-agents-"));
  fs.mkdirSync(path.join(agentsHome, ".agents"));
  fs.writeFileSync(path.join(agentsHome, ".agents", "AGENTS.md"), "destructive-ask-always\n");
  const prev = process.env.HOME;
  process.env.HOME = agentsHome;
  try {
    const blocked = await evalIn("bash", { command: "rm -rf /tmp/z" }, cleanCwd, true);
    check("cross-tool ~/.agents/AGENTS.md: destructive denied",
      blocked?.block === true && /destructive-ask-always/.test(blocked?.reason ?? ""),
      JSON.stringify(blocked));
  } finally {
    process.env.HOME = prev;
    fs.rmSync(agentsHome, { recursive: true, force: true });
  }
}

// ── 6. 模式切换语义: manual -> ask, yolo -> approve ───────────────────────
permissionManager.resetHistory();
{
  permissionManager.setMode("manual");
  const manualBlocked = await evalIn("bash", { command: "echo mode-probe-6" }, cleanCwd, false);
  check("manual: ordinary bash falls through to ask", manualBlocked?.block === true, JSON.stringify(manualBlocked));

  permissionManager.setMode("yolo");
  const yoloAllowed = await evalIn("bash", { command: "echo mode-probe-6b" }, cleanCwd, false);
  check("yolo: ordinary bash approved without asking", yoloAllowed === undefined, JSON.stringify(yoloAllowed));

  // Safety guards still run before yolo: destructive still asks under yolo.
  const yoloDestructive = await evalIn("bash", { command: "rm -rf /tmp/w" }, cleanCwd, false);
  check("yolo: destructive still intercepted before yolo-approve", yoloDestructive?.block === true, JSON.stringify(yoloDestructive));
}

// Restore a sane default mode for any later in-process consumer.
permissionManager.setMode("manual");
permissionManager.resetHistory();

// 无 UI（print/RPC）时 block reason 必须明确告知模型"未执行"，防弱模型谎报成功
permissionManager.setMode("manual");
{
  const r = await permissionManager.evaluate("edit", { path: "src/app.ts" }, cleanCwd, {
    hasUI: false,
    sessionId: "perm-test-session",
    ui: { confirm: async () => false },
  });
  check("no-UI: edit is blocked", r?.block === true, JSON.stringify(r));
  check("no-UI: reason states NOT executed explicitly",
    /NOT executed/i.test(r?.reason ?? ""), r?.reason);
  check("no-UI: reason is actionable (mentions permission mode)",
    /permission mode|interactively/i.test(r?.reason ?? ""), r?.reason);
}

permissionManager.setMode("manual");
permissionManager.resetHistory();
fs.rmSync(cleanCwd, { recursive: true, force: true });

// ---- loadDefaultMode (config.ts) ----
const { loadDefaultMode } = loadTs(`${EXT}/packages/core/permission/config.ts`);

// A: no config anywhere → manual
check("defaultMode falls back to manual with no config", loadDefaultMode() === "manual");

// B: global permissions.json defaultMode:auto → auto
const globalDir = path.join(process.env.HOME, ".pi", "agent");
fs.mkdirSync(globalDir, { recursive: true });
fs.writeFileSync(path.join(globalDir, "permissions.json"), JSON.stringify({ defaultMode: "auto" }));
check("defaultMode reads global permissions.json", loadDefaultMode() === "auto");

// C: invalid value → manual
fs.writeFileSync(path.join(globalDir, "permissions.json"), JSON.stringify({ defaultMode: "nonsense" }));
check("defaultMode rejects invalid values", loadDefaultMode() === "manual");

// D: global wins over project (first hit)
fs.writeFileSync(path.join(globalDir, "permissions.json"), JSON.stringify({ defaultMode: "yolo" }));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-proj-"));
fs.mkdirSync(path.join(projDir, ".pi"), { recursive: true });
fs.writeFileSync(path.join(projDir, ".pi", "permissions.json"), JSON.stringify({ defaultMode: "manual" }));
const prevCwd = process.cwd();
process.chdir(projDir);
check("defaultMode global wins over project", loadDefaultMode() === "yolo");
process.chdir(prevCwd);
fs.rmSync(projDir, { recursive: true, force: true });
fs.rmSync(globalDir, { recursive: true, force: true });

// ── 7. pi-multiloop 安装守卫（known-tool-conflict-install-deny）──────────
// pi-multiloop 的 get_goal/update_goal 与 harness Goal 工具同名 —— 工具名冲突
// 是 pi 启动致命错误（实测 pi 0.85.1：exit 1, "Tool get_goal conflicts"）。
// 守卫拦截两条路径：bash 的 pi install 命令、write/edit 直改 ~/.pi/agent/settings.json。
{
  const guardHome = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-guard-"));
  const settingsPath = path.join(guardHome, ".pi", "agent", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  // 7a. auto: pi install npm:pi-multiloop → deny（即使模拟用户同意）
  permissionManager.resetHistory();
  permissionManager.setMode("auto");
  const blocked = await evalIn("bash", { command: "pi install npm:pi-multiloop" }, cleanCwd, true);
  check("multiloop-guard: auto denies 'pi install npm:pi-multiloop'",
    blocked?.block === true && /fatal|conflict/i.test(blocked?.reason ?? ""), JSON.stringify(blocked));

  // 7b. yolo: 同样 deny（安全层先于 yolo-approve）
  permissionManager.setMode("yolo");
  const blockedYolo = await evalIn("bash", { command: "pi install git:github.com/lhl/pi-multiloop" }, cleanCwd, true);
  check("multiloop-guard: yolo still denies pi-multiloop install",
    blockedYolo?.block === true, JSON.stringify(blockedYolo));

  // 7c. 合法包安装不受影响
  permissionManager.setMode("auto");
  const okInstall = await evalIn("bash", { command: "pi install npm:pi-web-access" }, cleanCwd, true);
  check("multiloop-guard: non-conflicting pi install passes through",
    okInstall === undefined, JSON.stringify(okInstall));

  // 7d. write settings.json 加 pi-multiloop → deny
  const blockedWrite = await evalIn("write",
    { path: settingsPath, content: '{"packages":["npm:pi-multiloop"]}' }, cleanCwd, true);
  check("multiloop-guard: write settings.json with pi-multiloop denied",
    blockedWrite?.block === true, JSON.stringify(blockedWrite));

  // 7e. write settings.json 不含 pi-multiloop（正常编辑）→ 放行
  const okWrite = await evalIn("write", { path: settingsPath, content: '{"theme":"dark"}' }, cleanCwd, true);
  check("multiloop-guard: normal settings.json edit passes through",
    okWrite === undefined, JSON.stringify(okWrite));

  // 7f. edit settings.json newText 含 pi-multiloop → deny
  const blockedEdit = await evalIn("edit",
    { path: settingsPath, edits: [{ oldText: '"npm:pi-subagents"', newText: '"npm:pi-subagents",\n    "npm:pi-multiloop"' }] },
    cleanCwd, true);
  check("multiloop-guard: edit settings.json adding pi-multiloop denied",
    blockedEdit?.block === true, JSON.stringify(blockedEdit));

  // 7g. 普通 md 文件提到 pi-multiloop（文档/预设文件）→ 不拦
  const docOk = await evalIn("write", { path: "notes.md", content: "NOT included: pi-multiloop (fatal conflict)" }, cleanCwd, true);
  check("multiloop-guard: ordinary files mentioning pi-multiloop pass",
    docOk === undefined, JSON.stringify(docOk));

  fs.rmSync(guardHome, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
