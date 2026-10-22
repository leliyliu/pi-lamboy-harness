// Goal state machine unit tests (pure, no pi runtime, no model quota).
// Same jiti.transform-based loader as permission.test.mjs — see that file
// for the rationale (jiti 2.7.0 stale-namespace behavior on `export let`).
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
const { goalManager } = loadTs(`${EXT}/packages/core/goal/index.ts`);
const { registerGoalTools } = loadTs(`${EXT}/packages/core/goal/tools.ts`);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function reset() {
  // clear() drops the current goal AND its block-attempt counter.
  goalManager.clear();
}

// ── 1. active 守卫: 重复 createGoal 抛错, replace=true 覆盖 ───────────────
reset();
{
  const g1 = goalManager.createGoal("objective one");
  check("createGoal returns active goal", g1.status === "active" && goalManager.getGoal()?.goalId === g1.goalId);

  let threw = false;
  try {
    goalManager.createGoal("objective two");
  } catch (e) {
    threw = /active/.test(String(e?.message ?? e));
  }
  check("createGoal with active goal (no replace) throws", threw);

  const g2 = goalManager.createGoal("objective two", undefined, undefined, "user", true);
  check("createGoal with replace=true overwrites",
    g2.objective === "objective two" && goalManager.getGoal()?.goalId === g2.goalId && g2.goalId !== g1.goalId);
}

// ── 2. block 三次阈值: 同一 reason 前 2 次不变, 第 3 次 blocked ──────────
reset();
{
  goalManager.createGoal("block threshold probe");
  const r1 = goalManager.block("network down");
  check("block attempt 1/3 keeps status", r1?.status === "active", r1?.status);
  const r2 = goalManager.block("network down");
  check("block attempt 2/3 keeps status", r2?.status === "active", r2?.status);
  const r3 = goalManager.block("network down");
  check("block attempt 3/3 enters blocked", r3?.status === "blocked", r3?.status);
  check("blocked goal carries terminalReason", goalManager.getGoal()?.terminalReason === "network down",
    goalManager.getGoal()?.terminalReason);

  // A different reason starts a fresh 3-round window.
  goalManager.resume();
  const d1 = goalManager.block("different reason");
  check("new reason after resume starts fresh window", d1?.status === "active", d1?.status);
}

// ── 3. completionCriterion 门控: 未验证拒绝, verified=true 成功 ───────────
reset();
{
  goalManager.createGoal("criterion probe", "all tests green");
  const refused = goalManager.complete("user", "done?", false);
  check("complete without verification refused (returns null)", refused === null, JSON.stringify(refused));
  check("goal untouched after refused completion", goalManager.getGoal()?.status === "active",
    goalManager.getGoal()?.status);

  const ok = goalManager.complete("user", "all green", true);
  check("complete with verified=true succeeds", ok?.status === "complete", ok?.status);
  check("completionSummary preserved", goalManager.getGoal()?.completionSummary === "all green",
    goalManager.getGoal()?.completionSummary);
}

// ── 3b. 无 criterion 的目标可自由 complete ────────────────────────────────
reset();
{
  goalManager.createGoal("no criterion probe");
  const ok = goalManager.complete("user");
  check("complete without criterion succeeds without verified flag", ok?.status === "complete", ok?.status);
}

// ── 4. editGoal 不静默复活状态 ────────────────────────────────────────────
reset();
{
  goalManager.createGoal("edit probe");
  goalManager.pause();
  check("pause works", goalManager.getGoal()?.status === "paused", goalManager.getGoal()?.status);

  const edited = goalManager.editGoal("edited objective", undefined, "user");
  check("editGoal updates objective", edited?.objective === "edited objective", edited?.objective);
  check("editGoal preserves paused status (no silent revive)",
    goalManager.getGoal()?.status === "paused", goalManager.getGoal()?.status);

  // Explicit status override still works when requested.
  goalManager.editGoal("edited objective", undefined, "user", "active");
  check("editGoal honors explicit status override", goalManager.getGoal()?.status === "active",
    goalManager.getGoal()?.status);
}

// ── 5. restore 单调合并: 同 goalId 的过期 entry 不回退计数器 ─────────────
// (徽标 turns 闪变的修复核心: recordTurn 每次都持久化, 恢复侧取 max,
//  内存新值永远不会被 entry 旧值回拉)
reset();
{
  goalManager.createGoal("merge probe");
  goalManager.recordTurn(100);
  goalManager.recordTurn(100);
  const cur = goalManager.getGoal();
  check("recordTurn accumulates counters", cur?.turnsUsed === 2 && cur?.tokensUsed === 200,
    JSON.stringify({ t: cur?.turnsUsed, tok: cur?.tokensUsed }));

  const stale = { ...cur, turnsUsed: 1, tokensUsed: 50, wallClockMs: 0 };
  goalManager.restoreFromData(stale);
  const after = goalManager.getGoal();
  check("stale entry (same goalId) does not regress counters (max merge)",
    after?.turnsUsed === 2 && after?.tokensUsed === 200,
    JSON.stringify({ t: after?.turnsUsed, tok: after?.tokensUsed }));

  // 不同 goalId(会话切换)允许整体替换
  goalManager.restoreFromData({ ...stale, goalId: "g-other-session", turnsUsed: 0, tokensUsed: 0 });
  check("different goalId replaces wholesale (session switch)",
    goalManager.getGoal()?.goalId === "g-other-session" && goalManager.getGoal()?.turnsUsed === 0);
}

// ── 6. tryRestoreFromEntries: 仅空状态恢复 + complete 墓碑不恢复 ─────────
function goalEntry(data) { return { type: "custom", customType: "lamboy_goal", data }; }
function entryData(over = {}) {
  return {
    goalId: "g-e1", objective: "entry goal", status: "active", lastActor: "user",
    lastActedAt: new Date().toISOString(), turnsUsed: 7, tokensUsed: 70, wallClockMs: 700,
    ...over,
  };
}
reset();
{
  // 6a. 空状态 + 有效 entry → 恢复
  const restored = goalManager.tryRestoreFromEntries([goalEntry(entryData())]);
  check("restore-if-empty restores latest goal entry",
    restored === true && goalManager.getGoal()?.turnsUsed === 7,
    JSON.stringify({ restored, t: goalManager.getGoal()?.turnsUsed }));

  // 6b. 已有内存状态时, 过期 entry 不覆盖(restore-if-empty 守卫)
  goalManager.recordTurn(10); // turns 7 → 8
  goalManager.tryRestoreFromEntries([goalEntry(entryData({ turnsUsed: 3, tokensUsed: 30 }))]);
  check("existing in-memory goal is not overwritten by stale entries",
    goalManager.getGoal()?.turnsUsed === 8, String(goalManager.getGoal()?.turnsUsed));
}
reset();
{
  // 6c. 最新 entry 是 complete 墓碑 → 不恢复, 也不回退到更老的 active entry
  const entries = [
    goalEntry(entryData({ goalId: "g-old", turnsUsed: 5 })),
    goalEntry(entryData({ goalId: "g-old", status: "complete", turnsUsed: 6 })),
  ];
  const r = goalManager.tryRestoreFromEntries(entries);
  check("latest complete entry acts as tombstone (no restore, no fall-through)",
    r === false && goalManager.getGoal() === null, JSON.stringify({ r }));
}

// ── 7. clear() 写墓碑: 清除后 restore 不复活目标 ─────────────────────────
reset();
{
  const appended = [];
  goalManager.setAppendEntry((type, data) => appended.push({ type, data }));
  goalManager.createGoal("tombstone probe");
  goalManager.recordTurn(10);
  goalManager.clear();
  goalManager.setAppendEntry(() => {});
  const tombstones = appended.filter(a => a.type === "lamboy_goal" && a.data?.status === "complete");
  check("clear() appends a complete-status tombstone entry", tombstones.length >= 1,
    JSON.stringify(appended.map(a => a.data?.status)));

  const entries = appended.map(a => goalEntry(a.data));
  const r = goalManager.tryRestoreFromEntries(entries);
  check("cleared goal is not resurrected from entries",
    r === false && goalManager.getGoal() === null, JSON.stringify({ r }));
}

// ── 8. recordTurn 每次都持久化(徽标单调的写侧保证) ───────────────────────
reset();
{
  const appended = [];
  goalManager.setAppendEntry((_type, data) => appended.push(data));
  goalManager.createGoal("persist probe");
  goalManager.recordTurn(10);
  goalManager.recordTurn(10);
  goalManager.setAppendEntry(() => {});
  const turnsSeq = appended.map(d => d.turnsUsed);
  check("recordTurn persists every turn (monotonic entry sequence)",
    JSON.stringify(turnsSeq) === JSON.stringify([0, 1, 2]), JSON.stringify(turnsSeq));
}

// ── 9. update_goal 工具层: criterion 门控 + 文档讲清 verified 约定 ───────
reset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const updateGoal = tools.get("update_goal");
  check("update_goal tool registered", !!updateGoal);

  const doc = [
    updateGoal.promptSnippet,
    ...(updateGoal.promptGuidelines ?? []),
    updateGoal.parameters?.properties?.status?.description ?? "",
    updateGoal.parameters?.properties?.verified?.description ?? "",
  ].join("\n");
  check("update_goal docs explain verified=true is required with a declared criterion",
    /verified=true/.test(doc) && /criterion/i.test(doc) && /refus/i.test(doc));

  const createGoal = tools.get("create_goal");
  const createDoc = [
    createGoal.promptSnippet,
    ...(createGoal.promptGuidelines ?? []),
    createGoal.parameters?.properties?.completion_criterion?.description ?? "",
  ].join("\n");
  check("create_goal docs warn that declaring a criterion gates completion on verified=true",
    /verified=true/.test(createDoc) && /criterion/i.test(createDoc));

  goalManager.createGoal("tool friction probe", "all tests green");
  const refused = await updateGoal.execute("tc1", { status: "complete" }, null, null, {});
  check("tool-layer complete without verified is refused with guidance",
    /verified=true/.test(refused.content?.[0]?.text ?? ""), refused.content?.[0]?.text);
  check("goal stays active after refused tool completion",
    goalManager.getGoal()?.status === "active", goalManager.getGoal()?.status);

  const ok = await updateGoal.execute("tc2", { status: "complete", verified: true }, null, null, {});
  check("tool-layer complete with verified=true succeeds",
    goalManager.getGoal()?.status === "complete", ok.content?.[0]?.text);
}

// ── 10. update_goal 从 usage_limited 自动恢复（429 卡死修复） ─────────────
// 根因: tools.ts case "active" 只路由 paused/blocked → resume(),
// usage_limited 走 else 分支返回原 goal, 状态纹丝不动。resume() 本身
// 只拒 complete, 本可恢复 usage_limited。本组验证路由被补上。
reset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const updateGoal = tools.get("update_goal");

  // 10a. usage_limited → update_goal(active) → 恢复 active
  goalManager.createGoal("usage_limited recovery probe");
  goalManager.markUsageLimited("429 RATE_LIMIT from jdcloud");
  check("usage_limited set", goalManager.getGoal()?.status === "usage_limited",
    goalManager.getGoal()?.status);
  await updateGoal.execute("tc-r1", { status: "active" }, null, null, {});
  check("usage_limited recovers to active via update_goal",
    goalManager.getGoal()?.status === "active", goalManager.getGoal()?.status);

  // 10b. budget_limited → update_goal(active) → 不恢复（保留用户决策）
  // 证据: recordTurn 的 tokensUsed 单调累积不重置, 恢复后必再超限,
  // LLM 自动恢复=白烧 token。budget_limited 须靠 set_goal_budget/ /goal resume。
  goalManager.clear();
  goalManager.createGoal("budget_limited no-auto-recovery probe");
  goalManager.markBudgetLimited("tokenBudget exceeded");
  check("budget_limited set", goalManager.getGoal()?.status === "budget_limited",
    goalManager.getGoal()?.status);
  await updateGoal.execute("tc-r2", { status: "active" }, null, null, {});
  check("budget_limited does NOT auto-recover (reserved for user decision)",
    goalManager.getGoal()?.status === "budget_limited", goalManager.getGoal()?.status);

  // 10c. complete → update_goal(active) → 不复活（墓碑保护）
  goalManager.clear();
  goalManager.createGoal("complete tombstone probe", "all green");
  goalManager.complete("user", "done", true);
  check("complete set", goalManager.getGoal()?.status === "complete",
    goalManager.getGoal()?.status);
  await updateGoal.execute("tc-r3", { status: "active" }, null, null, {});
  check("complete goal is not resurrected by update_goal(active)",
    goalManager.getGoal()?.status === "complete", goalManager.getGoal()?.status);

  // 10d. active → update_goal(active) → 幂等
  goalManager.clear();
  goalManager.createGoal("active idempotent probe");
  const before = goalManager.getGoal()?.goalId;
  await updateGoal.execute("tc-r4", { status: "active" }, null, null, {});
  check("active→active is idempotent (no-op, no resurrection)",
    goalManager.getGoal()?.status === "active" && goalManager.getGoal()?.goalId === before,
    goalManager.getGoal()?.status);
}

// ── 11. usage_limited wrap-up 文案改版（quant02 2026-09-16 429 卡死事故） ──
// 根因证据: quant02 session 02:40:50, 06:02–06:07 五轮, GLM-5.3 的 thinking
// 均引述旧文案 "tool calls are blocked / once the window clears, I may
// call update_goal" → 认定一切工具被阻塞且恢复条件不可观测, 连用户原样
// 贴出 update_goal(status="active") 都拒绝执行。
// 新文案: 明示 get_goal/update_goal 始终可用 + "能生成本回复=限流窗已过"
// 的可观测恢复判据 + 立即恢复指令。
reset();
{
  goalManager.createGoal("wrap-up wording probe");
  goalManager.markUsageLimited("429 tokens limit for minute");
  const text = goalManager.buildWrapUpInjection() ?? "";

  check("wrap-up 不再断言一刀切 'Tool calls are blocked'",
    !/Tool calls are blocked/.test(text), text.slice(0, 100));
  check("wrap-up 不再把恢复当许可式前提（may call → 立即恢复）",
    !/Once the provider quota window clears, you may call/.test(text), "");
  check("wrap-up 含立即恢复指令 update_goal(status=\"active\")",
    /update_goal\(status="active"\)/.test(text), "");
  check("wrap-up 给出可观测恢复判据（正在生成本回复=窗口已过）",
    /generating this/i.test(text), "");
  check("wrap-up 仍禁止 create_goal", /Do NOT call create_goal/.test(text), "");
  check("wrap-up 明示不再要求 wrap-up 小结（改要求继续干活）",
    /Do NOT write a wrap-up summary/.test(text), "");
}

// ── 12. shouldBlockTool 允许名单与注入文案声明一致 ──────────────────────
// 注入文案称 get_goal/update_goal 始终可用——本组锁定 core 层允许名单语义,
// 防止文案与 shouldBlockTool 漂移。
reset();
{
  goalManager.createGoal("allowlist probe");
  goalManager.markUsageLimited("429");
  check("usage_limited 放行 get_goal", goalManager.shouldBlockTool("get_goal") === false);
  check("usage_limited 放行 update_goal", goalManager.shouldBlockTool("update_goal") === false);
  check("usage_limited 阻塞 bash", goalManager.shouldBlockTool("bash") === true);
}

// ── 13. Token budget policy: 800k 默认 / 500k 下限（2026-09-29 用户策略） ──
// 需求: “预算不能这么小”。模型自选小预算是根因（工具描述无数值规范），
// 双层修复: 工具层强制（本组 13a-13g）+ 文案层规范（13h-13i）。
// 核心路径（用户 /goal create、队列 enqueue）不受策略影响（13j）。
const ENV_DEF = "PI_LAMBOY_GOAL_TOKEN_BUDGET";
const ENV_MIN = "PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET";
const savedDef = process.env[ENV_DEF], savedMin = process.env[ENV_MIN];
function policyReset() {
  reset();
  delete process.env[ENV_DEF];
  delete process.env[ENV_MIN];
}

// 13a. 未传 budgetLimits → tokenBudget 默认 800000
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  const r = await createGoal.execute("tb1", { objective: "default fill probe" }, null, null, {});
  const g = goalManager.getGoal();
  check("13a create_goal 未传 tokenBudget → 默认 800000",
    g?.budgetLimits?.tokenBudget === 800000, String(g?.budgetLimits?.tokenBudget));
  check("13a 返回文本注明默认策略提示",
    /800000/.test(r.content?.[0]?.text ?? "") && /defaulted/i.test(r.content?.[0]?.text ?? ""),
    r.content?.[0]?.text);
}

// 13b. 传 tokenBudget 50000 → 抬升到 500000 下限
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  const r = await createGoal.execute("tb2",
    { objective: "floor raise probe", budgetLimits: { tokenBudget: 50000 } }, null, null, {});
  const g = goalManager.getGoal();
  check("13b tokenBudget 50000 → 抬升 500000",
    g?.budgetLimits?.tokenBudget === 500000, String(g?.budgetLimits?.tokenBudget));
  check("13b 返回文本注明抬升提示",
    /500000/.test(r.content?.[0]?.text ?? "") && /raised/i.test(r.content?.[0]?.text ?? ""),
    r.content?.[0]?.text);
}

// 13c. 传 tokenBudget 600000 → 原样保留
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  await createGoal.execute("tb3",
    { objective: "pass-through probe", budgetLimits: { tokenBudget: 600000 } }, null, null, {});
  check("13c tokenBudget 600000 → 原样保留",
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 600000,
    String(goalManager.getGoal()?.budgetLimits?.tokenBudget));
}

// 13d. 环境变量覆盖默认值: PI_LAMBOY_GOAL_TOKEN_BUDGET=700000
policyReset();
process.env[ENV_DEF] = "700000";
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  await createGoal.execute("tb4", { objective: "env default probe" }, null, null, {});
  check("13d env 默认值 700000 生效",
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 700000,
    String(goalManager.getGoal()?.budgetLimits?.tokenBudget));
}

// 13e. 环境变量关闭抬升: PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET=0 + 传 50000 → 原样保留
policyReset();
process.env[ENV_MIN] = "0";
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  await createGoal.execute("tb5",
    { objective: "floor disabled probe", budgetLimits: { tokenBudget: 50000 } }, null, null, {});
  check("13e env MIN=0 关闭抬升 → 50000 原样保留",
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 50000,
    String(goalManager.getGoal()?.budgetLimits?.tokenBudget));
}

// 13f. set_goal_budget(unit=tokens) 值 300000 → 抬升到 500000
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  const setBudget = tools.get("set_goal_budget");
  await createGoal.execute("tb6", { objective: "set floor probe" }, null, null, {});
  await setBudget.execute("tb6b", { budget: 300000, unit: "tokens" }, null, null, {});
  check("13f set_goal_budget 300000 tokens → 抬升 500000",
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 500000,
    String(goalManager.getGoal()?.budgetLimits?.tokenBudget));
}

// 13g. set_goal_budget(unit=turns) → 不注入默认 tokenBudget
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  goalManager.createGoal("turns-only probe");
  const setBudget = tools.get("set_goal_budget");
  await setBudget.execute("tb7", { budget: 100, unit: "turns" }, null, null, {});
  check("13g set_goal_budget turns → turnBudget 100 生效且不注入 tokenBudget",
    goalManager.getGoal()?.budgetLimits?.turnBudget === 100 &&
    goalManager.getGoal()?.budgetLimits?.tokenBudget === undefined,
    JSON.stringify(goalManager.getGoal()?.budgetLimits));
}

// 13h. create_goal 文档声明策略（数值 + 环境变量名）
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  const doc = [
    createGoal.promptSnippet,
    ...(createGoal.promptGuidelines ?? []),
    createGoal.parameters?.properties?.budgetLimits?.description ?? "",
    createGoal.parameters?.properties?.budgetLimits?.properties?.tokenBudget?.description ?? "",
  ].join("\n");
  check("13h create_goal 文档含默认 800000",
    /800000|800,000|800k/i.test(doc), doc.slice(0, 400));
  check("13h create_goal 文档含下限 500000",
    /500000|500,000|500k/i.test(doc), "");
  check("13h create_goal 文档声明环境变量",
    doc.includes(ENV_DEF) && doc.includes(ENV_MIN), "");
}

// 13i. set_goal_budget 文档声明下限抬升
policyReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const setBudget = tools.get("set_goal_budget");
  const doc = [
    setBudget.promptSnippet,
    ...(setBudget.promptGuidelines ?? []),
    setBudget.parameters?.properties?.budget?.description ?? "",
  ].join("\n");
  check("13i set_goal_budget 文档声明 500000 下限抬升",
    /500000|500,000|500k/i.test(doc) && /floor|raise|raised/i.test(doc), doc.slice(0, 300));
}

// 13j. 核心路径不受策略影响（用户 /goal create、队列 enqueue 原样透传）
policyReset();
{
  goalManager.createGoal("core pass-through probe", undefined, { tokenBudget: 50000 });
  check("13j 核心 createGoal 原样保留 50000（策略仅在工具层）",
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 50000,
    String(goalManager.getGoal()?.budgetLimits?.tokenBudget));
  goalManager.clear();
  goalManager.createGoal("core no-limits probe");
  check("13j 核心 createGoal 无 limits → 保持无 limits",
    goalManager.getGoal()?.budgetLimits === undefined,
    JSON.stringify(goalManager.getGoal()?.budgetLimits));
}

// ── 14. A3 预算档位注入（80% 委派 / 95% handoff 落盘，spec §2-A3） ─────
const ENV_WARN = "PI_LAMBOY_GOAL_BUDGET_WARN";
const ENV_CRIT = "PI_LAMBOY_GOAL_BUDGET_CRIT";
const savedWarn = process.env[ENV_WARN], savedCrit = process.env[ENV_CRIT];
function tierReset() { reset(); delete process.env[ENV_WARN]; delete process.env[ENV_CRIT]; }
function tierAt(used) {
  goalManager.clear();
  goalManager.createGoal("tier probe", undefined, { tokenBudget: 50000 });
  goalManager.recordTurn(used);
  return goalManager.budgetBandGuidance() ?? "";
}

tierReset();
{
  check("14a 79% 无档位行", !/80%/.test(tierAt(39500)) && !/handoff/i.test(tierAt(39500)));
  const at80 = tierAt(40000);
  check("14b 80% 注入委派偏好行", /80%/.test(at80) && /delegation/i.test(at80), at80);
  check("14b 80% 无 handoff 落盘行", !/handoff/i.test(at80), at80);
  const at94 = tierAt(47000);
  check("14c 94% 仍是委派行、无 handoff 行", /80%/.test(at94) && /delegation/i.test(at94) && !/handoff/i.test(at94), at94);
  const at95 = tierAt(47500);
  check("14d 95% 注入 handoff 落盘指令", /95%/.test(at95) && /handoff tool NOW/i.test(at95), at95);
  // buildInjection 集成: 档位行随 active 注入一起出现
  check("14e buildInjection 含档位行", /95%/.test(goalManager.buildInjection() ?? ""), "");
}
// 14f. env 关闭档位
tierReset();
process.env[ENV_WARN] = "0";
check("14f WARN=0 关闭 80% 委派行", !/prefer delegation/i.test(tierAt(40000)) && !/≥80%/.test(tierAt(40000)));
tierReset();
process.env[ENV_CRIT] = "0";
{
  const line = tierAt(47500);
  check("14g CRIT=0 关闭 95% handoff 行（80% 委派行仍在）", !/handoff/i.test(line) && /80%/.test(line), line);
}
if (savedWarn === undefined) delete process.env[ENV_WARN]; else process.env[ENV_WARN] = savedWarn;
if (savedCrit === undefined) delete process.env[ENV_CRIT]; else process.env[ENV_CRIT] = savedCrit;

// ── 15. B1 budget_limited wrap-up 改版（耗尽 turn 先写 handoff 草稿） ────
reset();
{
  goalManager.createGoal("wrap-up budget probe");
  goalManager.markBudgetLimited("tokenBudget exceeded");
  const text = goalManager.buildWrapUpInjection() ?? "";
  check("15a 注入指示立即调 handoff 工具写 briefing",
    /handoff tool NOW/i.test(text) && /briefing/i.test(text), text.slice(0, 150));
  check("15b 注入声明白名单 get_goal/handoff/update_goal",
    /get_goal/.test(text) && /handoff/.test(text) && /update_goal/.test(text), "");
  check("15c 注入禁止继续 goal 工作", /Do NOT continue goal work/i.test(text), "");
  check("15d 注入指向 /handoff 一键续接", /\/handoff/i.test(text), "");
  check("15e 注入要求 briefing 含 objective/criterion/剩余工作/建议预算",
    /objective/i.test(text) && /criterion/i.test(text) && /remaining/i.test(text) && /budget/i.test(text), "");
  // usage_limited 分支回归由第 11 节锁定，不在此重复
}

// ── 16. B2 shouldBlockTool 矩阵（budget/usage limited × 白名单） ────────
reset();
{
  goalManager.createGoal("block matrix probe");
  goalManager.markBudgetLimited("exceeded");
  check("16a budget_limited 放行 get_goal", goalManager.shouldBlockTool("get_goal") === false);
  check("16a budget_limited 放行 update_goal", goalManager.shouldBlockTool("update_goal") === false);
  check("16a budget_limited 放行 handoff（B1 落盘通道）", goalManager.shouldBlockTool("handoff") === false);
  check("16a budget_limited 阻塞 read", goalManager.shouldBlockTool("read") === true);
  check("16a budget_limited 阻塞 bash", goalManager.shouldBlockTool("bash") === true);
  check("16a budget_limited 阻塞 subagent", goalManager.shouldBlockTool("subagent") === true);
  check("16a budget_limited 阻塞 write", goalManager.shouldBlockTool("write") === true);

  goalManager.clear();
  goalManager.createGoal("usage allowlist probe");
  goalManager.markUsageLimited("429");
  check("16b usage_limited 也放行 handoff", goalManager.shouldBlockTool("handoff") === false);
  check("16b usage_limited 仍阻塞 bash", goalManager.shouldBlockTool("bash") === true);

  goalManager.clear();
  goalManager.createGoal("active probe");
  check("16c active 不阻塞任何工具",
    goalManager.shouldBlockTool("read") === false &&
    goalManager.shouldBlockTool("subagent") === false &&
    goalManager.shouldBlockTool("bash") === false);
}

// ── 17. B3 /goal resume 自动 top-up（修 resume 陷阱） ───────────────────
const ENV_TOPUP = "PI_LAMBOY_GOAL_TOPUP_MAX";
const savedTopup = process.env[ENV_TOPUP];
function topupReset() { reset(); delete process.env[ENV_TOPUP]; }

topupReset();
{
  goalManager.createGoal("topup probe", undefined, { tokenBudget: 50000 });
  goalManager.recordTurn(60000); // 60000 >= 50000 → budget_limited
  check("17a 超限后 budget_limited", goalManager.getGoal()?.status === "budget_limited",
    goalManager.getGoal()?.status);
  const r1 = goalManager.resumeWithTopUp("user");
  check("17b 首次 resume 自动 top-up → 560000（+500k 规则胜 25% 规则的 100k）",
    r1?.kind === "topped-up" && goalManager.getGoal()?.budgetLimits?.tokenBudget === 560000,
    JSON.stringify({ kind: r1?.kind, b: goalManager.getGoal()?.budgetLimits?.tokenBudget }));
  check("17b resume 后 status=active", goalManager.getGoal()?.status === "active",
    goalManager.getGoal()?.status);
  check("17b topUps=1 记录在 snapshot", goalManager.getGoal()?.topUps === 1,
    String(goalManager.getGoal()?.topUps));
  check("17b tokensUsed 不重置（仍 60000）", goalManager.getGoal()?.tokensUsed === 60000,
    String(goalManager.getGoal()?.tokensUsed));

  goalManager.recordTurn(510000); // 570000 >= 560000 → 再超限
  check("17c 再超限再次 budget_limited", goalManager.getGoal()?.status === "budget_limited");
  const r2 = goalManager.resumeWithTopUp("user");
  check("17c 第二次 top-up 取大者 1070000（+500k 胜 25% 规则的 750k）",
    r2?.kind === "topped-up" && goalManager.getGoal()?.budgetLimits?.tokenBudget === 1070000,
    JSON.stringify({ kind: r2?.kind, b: goalManager.getGoal()?.budgetLimits?.tokenBudget }));

  goalManager.recordTurn(1000000); // 1570000 >= 1070000 → 再超限
  const r3 = goalManager.resumeWithTopUp("user");
  check("17d 第三次 top-up 2070000，topUps=3",
    r3?.kind === "topped-up" && goalManager.getGoal()?.topUps === 3,
    JSON.stringify({ kind: r3?.kind, t: goalManager.getGoal()?.topUps }));

  goalManager.recordTurn(2070000); // 3640000 >= 2070000 → 再超限
  const r4 = goalManager.resumeWithTopUp("user");
  check("17e 第四次 resume: limit-reached，预算不再抬升",
    r4?.kind === "limit-reached" &&
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 2070000,
    JSON.stringify({ kind: r4?.kind, b: goalManager.getGoal()?.budgetLimits?.tokenBudget }));
  check("17e limit-reached 仍 resume 为 active（用户显式决策）",
    goalManager.getGoal()?.status === "active", goalManager.getGoal()?.status);
  check("17e topUps 保持 3 不增", goalManager.getGoal()?.topUps === 3,
    String(goalManager.getGoal()?.topUps));
}
// 17f. paused（非超限）resume 不碰预算、不计 topUps
topupReset();
{
  goalManager.createGoal("paused probe", undefined, { tokenBudget: 50000 });
  goalManager.pause("user");
  const r = goalManager.resumeWithTopUp("user");
  check("17f paused → 普通 resume（kind=resumed，预算不变，无 topUps）",
    r?.kind === "resumed" &&
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 50000 &&
    goalManager.getGoal()?.topUps === undefined,
    JSON.stringify({ kind: r?.kind, t: goalManager.getGoal()?.topUps }));
}
// 17g. env TOPUP_MAX=0 → 不限次数
topupReset();
process.env[ENV_TOPUP] = "0";
{
  goalManager.createGoal("unlimited probe", undefined, { tokenBudget: 50000 });
  let kinds = [];
  goalManager.recordTurn(60000);
  for (let i = 0; i < 4; i++) {
    kinds.push(goalManager.resumeWithTopUp("user")?.kind);
    const b = goalManager.getGoal()?.budgetLimits?.tokenBudget ?? 0;
    goalManager.recordTurn(b); // 强制再超限
  }
  check("17g TOPUP_MAX=0 → 第 4 次 top-up 仍 topped-up",
    kinds[3] === "topped-up", JSON.stringify(kinds));
}
// 17h. update_goal(active) 对 budget_limited 仍 no-op（用户入口独占，回归 10b 意图）
topupReset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const updateGoal = tools.get("update_goal");
  goalManager.createGoal("no-auto-recover probe", undefined, { tokenBudget: 50000 });
  goalManager.recordTurn(60000);
  await updateGoal.execute("tc-tu", { status: "active" }, null, null, {});
  check("17h budget_limited 不被 update_goal(active) 恢复",
    goalManager.getGoal()?.status === "budget_limited", goalManager.getGoal()?.status);
  check("17h 也不因 no-op 恢复偷跑 top-up",
    goalManager.getGoal()?.topUps === undefined, String(goalManager.getGoal()?.topUps));
}
// 17i. topUps 持久化 roundtrip（entry 序列化 + 恢复）
topupReset();
{
  const appended = [];
  goalManager.setAppendEntry((_t, d) => appended.push(d));
  goalManager.createGoal("persist topups probe", undefined, { tokenBudget: 50000 });
  goalManager.recordTurn(60000);
  goalManager.resumeWithTopUp("user");
  goalManager.setAppendEntry(() => {});
  const entry = appended[appended.length - 1];
  check("17i entry 携带 topUps=1", entry?.topUps === 1, JSON.stringify(entry?.topUps));

  const { goalFromEntryData } = loadTs(`${EXT}/packages/core/goal/persistence.ts`);
  const restored = goalFromEntryData(entry);
  check("17i goalFromEntryData 保留 topUps", restored.topUps === 1, JSON.stringify(restored.topUps));

  goalManager.clear();
  goalManager.restoreFromData(restored);
  check("17i restoreFromData 保留 topUps", goalManager.getGoal()?.topUps === 1,
    String(goalManager.getGoal()?.topUps));
}
if (savedTopup === undefined) delete process.env[ENV_TOPUP]; else process.env[ENV_TOPUP] = savedTopup;

// ── 18. A1 active 注入委派指引（env 可关） ────────────────────────────
const ENV_DELEG = "PI_LAMBOY_GOAL_DELEGATION";
const savedDeleg = process.env[ENV_DELEG];
reset();
{
  goalManager.createGoal("delegation injection probe");
  const text = goalManager.buildInjection() ?? "";
  check("18a active 注入含委派指引段（Delegation + subagent）",
    /Delegation/.test(text) && /subagent/i.test(text), text.slice(0, 200));
  check("18a 指引含边界（琐碎改动留父会话）", /trivial/i.test(text), "");
  check("18a 指引说明委派记账（child tokens 计入预算）", /budget/i.test(text), "");
}
process.env[ENV_DELEG] = "0";
{
  goalManager.clear();
  goalManager.createGoal("delegation off probe");
  check("18b env=0 关闭委派段", !/Delegation/.test(goalManager.buildInjection() ?? ""));
}
if (savedDeleg === undefined) delete process.env[ENV_DELEG]; else process.env[ENV_DELEG] = savedDeleg;
reset();
{
  goalManager.createGoal("paused delegation probe");
  goalManager.pause();
  check("18c paused 注入无委派段", !/Delegation/.test(goalManager.buildInjection() ?? ""));
}

// ── 19. A4 create_goal 文档含委派指引 ──────────────────────────────
reset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  const doc = [createGoal.promptSnippet, ...(createGoal.promptGuidelines ?? [])].join("\n");
  check("19 create_goal 文档鼓励 goal 下主动委派",
    /delegat/i.test(doc) && /subagent|scout|worker/i.test(doc), doc.slice(0, 300));
}

// ── 20. B4 autoExtend（默认关；开启时跨越 tokenBudget 自动续期而非 budget_limited） ──
const ENV_STEP = "PI_LAMBOY_GOAL_EXTEND_STEP";
const ENV_MAX2 = "PI_LAMBOY_GOAL_TOPUP_MAX";
const savedStep = process.env[ENV_STEP], savedMax2 = process.env[ENV_MAX2];
function b4Reset() { reset(); delete process.env[ENV_STEP]; delete process.env[ENV_MAX2]; }

b4Reset();
{
  goalManager.createGoal("autoextend probe", undefined, { tokenBudget: 50000 }, "user", false, true);
  const r = goalManager.recordTurn(60000);
  const g = goalManager.getGoal();
  check("20a autoExtend 开启：跨越 → 不进 budget_limited，预算 +500k",
    g?.status === "active" && g?.budgetLimits?.tokenBudget === 550000,
    JSON.stringify({ s: g?.status, b: g?.budgetLimits?.tokenBudget }));
  check("20a topUps=1 计入，tokensUsed 照记 60000",
    g?.topUps === 1 && g?.tokensUsed === 60000,
    JSON.stringify({ t: g?.topUps, tok: g?.tokensUsed }));
  check("20a recordTurn 返回 autoExtendedTo（供 notify）",
    r?.autoExtendedTo === 550000, JSON.stringify(r));
}
// 20b. 默认关（回归：无 autoExtend → budget_limited，10b 语义不变）
b4Reset();
{
  goalManager.createGoal("default off probe", undefined, { tokenBudget: 50000 });
  goalManager.recordTurn(60000);
  check("20b 默认关 → 跨越仍进 budget_limited",
    goalManager.getGoal()?.status === "budget_limited", goalManager.getGoal()?.status);
}
// 20c. topUps 上限保护：MAX=1 → 第二次跨越退化为 budget_limited
b4Reset();
process.env[ENV_MAX2] = "1";
{
  goalManager.createGoal("cap probe", undefined, { tokenBudget: 50000 }, "user", false, true);
  goalManager.recordTurn(60000); // extend → 550000, topUps=1
  check("20c 首次跨越自动续期", goalManager.getGoal()?.budgetLimits?.tokenBudget === 550000);
  goalManager.recordTurn(600000); // 660000 >= 550000 → cap reached
  check("20c 达上限退化为 budget_limited（预算不再抬升）",
    goalManager.getGoal()?.status === "budget_limited" &&
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 550000,
    JSON.stringify({ s: goalManager.getGoal()?.status, b: goalManager.getGoal()?.budgetLimits?.tokenBudget }));
  check("20c topUps 保持 1", goalManager.getGoal()?.topUps === 1,
    String(goalManager.getGoal()?.topUps));
}
// 20d. env 步长覆盖
b4Reset();
process.env[ENV_STEP] = "100000";
{
  goalManager.createGoal("step probe", undefined, { tokenBudget: 50000 }, "user", false, true);
  goalManager.recordTurn(60000);
  check("20d EXTEND_STEP=100000 → 预算抬到 150000",
    goalManager.getGoal()?.budgetLimits?.tokenBudget === 150000,
    String(goalManager.getGoal()?.budgetLimits?.tokenBudget));
}
// 20e. 委派 token（recordTokenUsage）也受 autoExtend 保护
b4Reset();
{
  goalManager.createGoal("delegated extend probe", undefined, { tokenBudget: 50000 }, "user", false, true);
  const r = goalManager.recordTokenUsage(60000);
  const g = goalManager.getGoal();
  check("20e 委派 token 跨越也自动续期（不进 budget_limited）",
    g?.status === "active" && g?.budgetLimits?.tokenBudget === 550000 && r?.autoExtendedTo === 550000,
    JSON.stringify({ s: g?.status, b: g?.budgetLimits?.tokenBudget, r: r?.autoExtendedTo }));
}
// 20f. 工具层：create_goal(autoExtend=true) 透传
b4Reset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  const doc = [createGoal.promptSnippet, ...(createGoal.promptGuidelines ?? []),
    createGoal.parameters?.properties?.autoExtend?.description ?? ""].join("\n");
  check("20f autoExtend 参数文档存在且声明默认关",
    /autoExtend/i.test(doc) && /default false/i.test(doc), doc.slice(0, 200));
  await createGoal.execute("ae1", { objective: "tool passthrough probe", autoExtend: true }, null, null, {});
  check("20f create_goal(autoExtend=true) 透传到 snapshot",
    goalManager.getGoal()?.autoExtend === true, String(goalManager.getGoal()?.autoExtend));
}
// 20g. autoExtend 持久化 roundtrip
b4Reset();
{
  const { goalToEntryData, goalFromEntryData } = loadTs(`${EXT}/packages/core/goal/persistence.ts`);
  goalManager.createGoal("persist autoextend probe", undefined, undefined, "user", false, true);
  const entry = goalToEntryData(goalManager.getGoal());
  check("20g entry 携带 autoExtend=true", entry?.autoExtend === true, JSON.stringify(entry?.autoExtend));
  const restored = goalFromEntryData(entry);
  check("20g 恢复保留 autoExtend", restored.autoExtend === true, JSON.stringify(restored.autoExtend));
}
// 20h. Finding 2 修复：token+turn 同 turn 双跨越 → 不消耗 top-up、预算不抬、状态 blocked
b4Reset();
{
  goalManager.createGoal("dual crossing probe", undefined,
    { tokenBudget: 50000, turnBudget: 3 }, "user", false, true);
  goalManager.recordTurn(1000); // turn 1
  goalManager.recordTurn(1000); // turn 2
  const r = goalManager.recordTurn(60000); // turn 3: 跨 turn 预算 + 跨 token 预算
  const g = goalManager.getGoal();
  check("20h 双跨越：turn 预算生效，状态 blocked（非 budget_limited）",
    g?.status === "blocked", JSON.stringify({ s: g?.status }));
  check("20h 双跨越：不消耗 top-up（预算保持 50000，topUps 未记）",
    g?.budgetLimits?.tokenBudget === 50000 && g?.topUps === undefined && r?.autoExtendedTo === undefined,
    JSON.stringify({ b: g?.budgetLimits?.tokenBudget, t: g?.topUps, r: r?.autoExtendedTo }));
  check("20h 双跨越：recordTurn 返回 crossedBudget=true",
    r?.crossedBudget === true, JSON.stringify(r));
}

if (savedStep === undefined) delete process.env[ENV_STEP]; else process.env[ENV_STEP] = savedStep;
if (savedMax2 === undefined) delete process.env[ENV_MAX2]; else process.env[ENV_MAX2] = savedMax2;

// ── 21. criterion 参数名回归（snake_case 读取修复） ──────────────────
// 事故（2026-10-19 实测）：创建 goal 时声明 completion_criterion，注入/面板却无
// criterion 行 → verified=true 完成门禁被旁路。排查发现未提交的 token-budget-policy
// 改写把 execute 的读取变成了 camelCase（params.completionCriterion），而 schema
// 声明的是 snake_case（completion_criterion，模型实际发送名）。本组锁定：双名兼容
// 读取 + criterion 存入 snapshot + 注入可见 + 门禁生效。
reset();
{
  const tools = new Map();
  registerGoalTools({ registerTool: (def) => tools.set(def.name, def) }, goalManager);
  const createGoal = tools.get("create_goal");
  await createGoal.execute("cc1",
    { objective: "criterion snake_case probe", completion_criterion: "all suites green" },
    null, null, {});
  const g = goalManager.getGoal();
  check("21a schema 名 completion_criterion 被读取并存入 snapshot",
    g?.completionCriterion === "all suites green", JSON.stringify(g?.completionCriterion));
  check("21b 注入含 criterion 行（完成门禁不再被旁路）",
    /all suites green/.test(goalManager.buildInjection() ?? ""), "");

  // 21c. camelCase 兼容保留（旧调用形态不破坏）
  goalManager.clear();
  await createGoal.execute("cc2",
    { objective: "camel compat probe", completionCriterion: "legacy shape" },
    null, null, {});
  check("21c camelCase 兼容保留", goalManager.getGoal()?.completionCriterion === "legacy shape",
    JSON.stringify(goalManager.getGoal()?.completionCriterion));

  // 21d. 门禁生效: 有 criterion 不传 verified 拒绝 complete
  goalManager.clear();
  const updateGoal = tools.get("update_goal");
  await createGoal.execute("cc3",
    { objective: "gate probe", completion_criterion: "gate holds" }, null, null, {});
  const refused = await updateGoal.execute("cc4", { status: "complete" }, null, null, {});
  check("21d criterion 存在时 complete 拒绝无 verified",
    /verified=true/.test(refused.content?.[0]?.text ?? "") &&
    goalManager.getGoal()?.status === "active",
    JSON.stringify({ t: refused.content?.[0]?.text?.slice(0, 80), s: goalManager.getGoal()?.status }));
}

// restore env
if (savedDef === undefined) delete process.env[ENV_DEF]; else process.env[ENV_DEF] = savedDef;
if (savedMin === undefined) delete process.env[ENV_MIN]; else process.env[ENV_MIN] = savedMin;

reset();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
