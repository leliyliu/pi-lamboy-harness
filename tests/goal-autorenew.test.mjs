// Goal 预算耗尽自动续接（auto-renew）—— 纯 core 单测，零模型配额。
//
// 决策（plans/2026-10-26-goal-budget-auto-renew-and-handoff.md §5）:
//   D1 = 自动 +800k，最多 10 次
//   D3 = 单 goal 总预算硬上限 8M
//   autoExtend 旧路径保留（topUps 计数），与 auto-renew 互斥且优先。
//
// env（全部在调用时读取，测试可逐用例覆盖）:
//   PI_LAMBOY_GOAL_AUTORENEW=0        关闭自动续接
//   PI_LAMBOY_GOAL_AUTORENEW_MAX     自动续接次数上限（默认 10，0 = 不限）
//   PI_LAMBOY_GOAL_MAX_TOKENS        单 goal 总预算上限（默认 8_000_000，0 = 不限）
//   PI_LAMBOY_GOAL_RENEW_STEP        每次扩展步长（默认 800_000）

import assert from "node:assert/strict";

const { goalManager } = await import("../packages/core/goal/index.ts");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const ENV_KEYS = [
  "PI_LAMBOY_GOAL_AUTORENEW",
  "PI_LAMBOY_GOAL_AUTORENEW_MAX",
  "PI_LAMBOY_GOAL_MAX_TOKENS",
  "PI_LAMBOY_GOAL_RENEW_STEP",
  "PI_LAMBOY_GOAL_TOPUP_MAX",
];
function reset(env = {}) {
  goalManager.clear();
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
}

// 公式：max(used + step, ceil(used*1.25/50k)*50k)，step 默认 800k。
function expectedBudget(used, step = 800_000) {
  return Math.max(used + step, Math.ceil((used * 1.25) / 50_000) * 50_000);
}

// ── 1. 默认：耗尽自动扩展并保持 active ────────────────────────────────
reset();
{
  goalManager.createGoal("autorenew probe", undefined, { tokenBudget: 800_000 }, "user");
  const r = goalManager.recordTurn(900_000);
  const g = goalManager.getGoal();
  check("auto-renew keeps goal active", g.status === "active", g.status);
  check("auto-renew crossedBudget=false", r.crossedBudget === false, JSON.stringify(r));
  check("auto-renew extends budget by formula",
    g.budgetLimits.tokenBudget === expectedBudget(900_000),
    `${g.budgetLimits.tokenBudget} vs ${expectedBudget(900_000)}`);
  check("auto-renew counts autoRenewals (not topUps)",
    (g.autoRenewals ?? 0) === 1 && (g.topUps ?? 0) === 0,
    JSON.stringify({ autoRenewals: g.autoRenewals, topUps: g.topUps }));
  check("auto-renew reports autoExtendedTo",
    r.autoExtendedTo === expectedBudget(900_000), String(r.autoExtendedTo));
  check("auto-renew reports count via autoRenewed",
    r.autoRenewed?.count === 1 && r.autoRenewed?.budget === expectedBudget(900_000),
    JSON.stringify(r.autoRenewed));
  // Watchdog assertions (review Finding 6): renewal must never lose or
  // mis-account the crossing turn, and the budget must stay above usage.
  check("auto-renew keeps accounting (turnsUsed/tokensUsed)",
    g.turnsUsed === 1 && g.tokensUsed === 900_000,
    JSON.stringify({ turns: g.turnsUsed, tokens: g.tokensUsed }));
  check("auto-renew budget > tokensUsed",
    g.budgetLimits.tokenBudget > g.tokensUsed,
    `${g.budgetLimits.tokenBudget} vs ${g.tokensUsed}`);
}

// ── 2. env 关闭 → 完全回到旧行为 ──────────────────────────────────────
reset({ PI_LAMBOY_GOAL_AUTORENEW: 0 });
{
  goalManager.createGoal("autorenew off probe", undefined, { tokenBudget: 800_000 }, "user");
  const r = goalManager.recordTurn(900_000);
  const g = goalManager.getGoal();
  check("disabled: goal stops budget_limited", g.status === "budget_limited", g.status);
  check("disabled: budget unchanged", g.budgetLimits.tokenBudget === 800_000,
    String(g.budgetLimits.tokenBudget));
  check("disabled: crossedBudget=true", r.crossedBudget === true, JSON.stringify(r));
  check("disabled: no autoRenewed field", r.autoRenewed === undefined, JSON.stringify(r.autoRenewed));
}

// ── 3. 次数上限（默认 10；测试用 2）────────────────────────────────────
reset({ PI_LAMBOY_GOAL_AUTORENEW_MAX: 2 });
{
  goalManager.createGoal("autorenew cap probe", undefined, { tokenBudget: 800_000 }, "user");
  goalManager.recordTurn(1_000_000); // #1 extend
  const after1 = goalManager.getGoal();
  goalManager.recordTurn(1_000_000); // #2 extend
  const after2 = goalManager.getGoal();
  const r3 = goalManager.recordTurn(1_000_000); // #3 → cap reached
  const after3 = goalManager.getGoal();
  check("cap: first two renewals keep active",
    after1.status === "active" && after2.status === "active" &&
    (after2.autoRenewals ?? 0) === 2,
    JSON.stringify({ s1: after1.status, s2: after2.status, n: after2.autoRenewals }));
  check("cap: third crossing stops budget_limited",
    after3.status === "budget_limited" && r3.crossedBudget === true,
    JSON.stringify({ status: after3.status, r: r3 }));
}

// ── 4. 总预算硬上限（默认 8M；测试用 1M）──────────────────────────────
reset({ PI_LAMBOY_GOAL_MAX_TOKENS: 1_000_000 });
{
  goalManager.createGoal("autorenew total cap probe", undefined, { tokenBudget: 800_000 }, "user");
  const r = goalManager.recordTurn(1_100_000); // newTokens 1.1M >= cap 1M
  const g = goalManager.getGoal();
  check("total cap: crossing beyond cap stops", g.status === "budget_limited", g.status);
  check("total cap: budget not extended", g.budgetLimits.tokenBudget === 800_000,
    String(g.budgetLimits.tokenBudget));
  check("total cap: crossedBudget=true", r.crossedBudget === true, JSON.stringify(r));
}

// ── 5. 非 token 预算越界不受自动续接影响 ──────────────────────────────
reset();
{
  goalManager.createGoal("turn cap probe", undefined,
    { tokenBudget: 10_000_000, turnBudget: 1 }, "user");
  goalManager.recordTurn(100); // turnsUsed 1 >= turnBudget 1 → blocked
  const g = goalManager.getGoal();
  check("turn budget crossing still blocks", g.status === "blocked", g.status);
  check("turn budget crossing does not count autoRenewals",
    (g.autoRenewals ?? 0) === 0, String(g.autoRenewals));
}

// ── 5b. token + turn 同时越界 → 绝不扩容 ─────────────────────────────
reset();
{
  goalManager.createGoal("dual crossing probe", undefined,
    { tokenBudget: 800_000, turnBudget: 1 }, "user");
  const r = goalManager.recordTurn(900_000); // turn 1 + token crossing
  const g = goalManager.getGoal();
  check("dual crossing: stops (never renews)",
    g.status === "budget_limited" && r.crossedBudget === true,
    JSON.stringify({ status: g.status, r }));
  check("dual crossing: budget untouched",
    g.budgetLimits.tokenBudget === 800_000, String(g.budgetLimits.tokenBudget));
  check("dual crossing: autoRenewals stays 0",
    (g.autoRenewals ?? 0) === 0, String(g.autoRenewals));
}

// ── 6. 旧 autoExtend 路径仍走 topUps（互斥）──────────────────────────
reset();
{
  goalManager.createGoal("autoextend probe", undefined, { tokenBudget: 800_000 }, "user", false, true);
  goalManager.recordTurn(900_000);
  const g = goalManager.getGoal();
  check("autoExtend: keeps active", g.status === "active", g.status);
  check("autoExtend: consumes topUps not autoRenewals",
    (g.topUps ?? 0) === 1 && (g.autoRenewals ?? 0) === 0,
    JSON.stringify({ topUps: g.topUps, autoRenewals: g.autoRenewals }));
}

// ── 6b. autoExtend topUp 用满 → auto-renew 接手（fall-through）────────
reset({ PI_LAMBOY_GOAL_TOPUP_MAX: 1 });
{
  goalManager.createGoal("autoextend fallthrough probe", undefined,
    { tokenBudget: 800_000 }, "user", false, true);
  goalManager.recordTurn(900_000); // autoExtend: +500k, topUps=1
  const first = goalManager.getGoal();
  goalManager.recordTurn(1_000_000); // 1.9M >= 1.7M, underCap=false → auto-renew
  const g = goalManager.getGoal();
  check("fall-through: autoExtend step first",
    first.status === "active" && first.budgetLimits.tokenBudget === 1_300_000 &&
    (first.topUps ?? 0) === 1,
    JSON.stringify({ s: first.status, b: first.budgetLimits.tokenBudget, t: first.topUps }));
  check("fall-through: auto-renew takes over after top-up cap",
    g.status === "active" && (g.autoRenewals ?? 0) === 1 && (g.topUps ?? 0) === 1,
    JSON.stringify({ s: g.status, ar: g.autoRenewals, t: g.topUps }));
}

// ── 7. 委派 token（recordTokenUsage）同样自动续接 ─────────────────────
reset();
{
  goalManager.createGoal("delegated autorenew probe", undefined, { tokenBudget: 800_000 }, "user");
  const r = goalManager.recordTokenUsage(900_000);
  const g = goalManager.getGoal();
  check("recordTokenUsage auto-renews", g.status === "active" && r.crossedBudget === false,
    JSON.stringify({ status: g.status, r }));
  check("recordTokenUsage increments autoRenewals",
    (g.autoRenewals ?? 0) === 1, String(g.autoRenewals));
}

// ── 8. autoRenewals 单调合并（stale entry 不回退）─────────────────────
reset();
{
  goalManager.createGoal("monotonic probe", undefined, { tokenBudget: 800_000 }, "user");
  goalManager.recordTurn(900_000);
  const live = goalManager.getGoal();
  goalManager.restoreFromData({ ...live, autoRenewals: 0, tokensUsed: 1 });
  check("autoRenewals is monotonic across restore",
    (goalManager.getGoal().autoRenewals ?? 0) === 1,
    String(goalManager.getGoal().autoRenewals));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
