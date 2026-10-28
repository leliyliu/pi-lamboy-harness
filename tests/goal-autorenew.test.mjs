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
  "PI_LAMBOY_GOAL_TOPUP_AT",
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

// ── 9. C1 提前量自动扩预算（80% 档就加，不等撞墙） ──────────────────
reset();
{
  goalManager.createGoal("headroom probe", undefined, { tokenBudget: 800_000 }, "user");
  const r = goalManager.recordTurn(640_000); // 80% of 800k
  const g = goalManager.getGoal();
  // Reviewer Finding 1 (2026-10-28): the step is sized from the CURRENT
  // BUDGET, not from usage — sizing from usage converges on 4M and burns all
  // 10 renewals there. So 800k + 800k = 1.6M, not expectedBudget(640k).
  check("headroom: 80% 档提前扩预算（按当前预算定步长）",
    g.budgetLimits.tokenBudget === expectedBudget(800_000),
    `${g.budgetLimits.tokenBudget} vs ${expectedBudget(800_000)}`);
  check("headroom: goal 保持 active", g.status === "active", g.status);
  check("headroom: autoRenewals +1", (g.autoRenewals ?? 0) === 1, String(g.autoRenewals));
  check("headroom: reason=headroom", r.autoRenewed?.reason === "headroom", JSON.stringify(r.autoRenewed));
  check("headroom: crossedBudget=false", r.crossedBudget === false, JSON.stringify(r));
}

reset();
{
  goalManager.createGoal("headroom below probe", undefined, { tokenBudget: 800_000 }, "user");
  goalManager.recordTurn(632_000); // 79%
  const g = goalManager.getGoal();
  check("headroom: 79% 不扩预算",
    g.budgetLimits.tokenBudget === 800_000 && (g.autoRenewals ?? 0) === 0,
    JSON.stringify({ b: g.budgetLimits.tokenBudget, ar: g.autoRenewals }));
}

// PI_LAMBOY_GOAL_TOPUP_AT=0 → 退回「撞墙才续」
reset({ PI_LAMBOY_GOAL_TOPUP_AT: 0 });
{
  goalManager.createGoal("headroom off probe", undefined, { tokenBudget: 800_000 }, "user");
  goalManager.recordTurn(640_000);
  const mid = goalManager.getGoal();
  check("headroom off: 80% 不预扩",
    mid.budgetLimits.tokenBudget === 800_000 && (mid.autoRenewals ?? 0) === 0,
    JSON.stringify({ b: mid.budgetLimits.tokenBudget, ar: mid.autoRenewals }));
  const r = goalManager.recordTurn(260_000); // 累计 900k → 撞墙
  check("headroom off: 撞墙仍 auto-renew（reason=crossing）",
    goalManager.getGoal().status === "active" && r.autoRenewed?.reason === "crossing",
    JSON.stringify({ s: goalManager.getGoal().status, r: r.autoRenewed }));
}

// 总预算硬上限：提前量不能突破，且到顶后不再反复扩
reset({ PI_LAMBOY_GOAL_MAX_TOKENS: 1_000_000 });
{
  goalManager.createGoal("headroom cap probe", undefined, { tokenBudget: 800_000 }, "user");
  goalManager.recordTurn(640_000);
  const g = goalManager.getGoal();
  check("headroom: 受总预算上限约束", g.budgetLimits.tokenBudget === 1_000_000, String(g.budgetLimits.tokenBudget));
  const r2 = goalManager.recordTokenUsage(200_000); // used 840k, budget already at cap
  check("headroom: 触顶后不再扩",
    goalManager.getGoal().budgetLimits.tokenBudget === 1_000_000 && r2.autoRenewed === undefined,
    JSON.stringify(r2));
}

// 双跨越（turn 同时越界）不消耗提前量
reset();
{
  goalManager.createGoal("headroom dual probe", undefined, { tokenBudget: 800_000, turnBudget: 1 }, "user");
  goalManager.recordTurn(640_000);
  const g = goalManager.getGoal();
  check("headroom: turn 同时越界时不预扩",
    g.status !== "active" && (g.autoRenewals ?? 0) === 0,
    JSON.stringify({ s: g.status, ar: g.autoRenewals }));
}

// headroom 需能一路撑到 8M 硬上限（不是提前烧光 10 次续接）
// Reviewer Finding 1 回归：固定点 b=0.8b+800k=4M 的错误实现在 used≈3.66M 就停。
reset();
{
  goalManager.createGoal("headroom ceiling probe", undefined, { tokenBudget: 800_000 }, "user");
  let guard = 0;
  while (goalManager.getGoal().status === "active" && guard++ < 200) {
    const g = goalManager.getGoal();
    goalManager.recordTurn(50_000);
  }
  const g = goalManager.getGoal();
  check("headroom: 反复续接能到达 8M 硬上限（而非 4M 固定点）",
    g.budgetLimits.tokenBudget === 8_000_000,
    String(g.budgetLimits.tokenBudget));
  check("headroom: 总续接次数 ≤ 默认上限 10",
    (g.autoRenewals ?? 0) <= 10, String(g.autoRenewals));
  check("headroom: 最终停在 budget_limited（硬上限）",
    g.status === "budget_limited", g.status);
  check("headroom: 停止时用量接近 8M（未提前烧完配额）",
    g.tokensUsed >= 7_900_000,
    String(g.tokensUsed));
}

// recordTokenUsage（委派 token）同样享受提前量 top-up
reset();
{
  goalManager.createGoal("headroom delegated probe", undefined, { tokenBudget: 800_000 }, "user");
  const r = goalManager.recordTokenUsage(640_000);
  const g = goalManager.getGoal();
  check("headroom: recordTokenUsage 也预扩",
    g.budgetLimits.tokenBudget === expectedBudget(800_000) && r.autoRenewed?.reason === "headroom",
    JSON.stringify({ b: g.budgetLimits.tokenBudget, r: r.autoRenewed }));
  check("headroom: recordTokenUsage 不计 turn",
    g.turnsUsed === 0, String(g.turnsUsed));
}

// ── 10. C2 autoRecoverBudget（budget_limited 再入点） ───────────────
function restoreLimited(used, budget, extra = {}) {
  goalManager.clear();
  goalManager.restoreFromData({
    goalId: "g-recover-probe", objective: "recover probe", status: "budget_limited",
    lastActor: "runtime", lastActedAt: new Date().toISOString(), turnsUsed: 5,
    tokensUsed: used, wallClockMs: 0, budgetLimits: { tokenBudget: budget },
    terminalReason: "Budget exceeded", ...extra,
  });
}

reset();
{
  restoreLimited(900_000, 800_000);
  const r = goalManager.autoRecoverBudget("runtime");
  const g = goalManager.getGoal();
  check("recover: budget_limited 自动复活",
    r?.extended === true && r.resumed === true && g.status === "active",
    JSON.stringify({ r, s: g.status }));
  check("recover: 预算扩到公式值", g.budgetLimits.tokenBudget === expectedBudget(900_000),
    String(g.budgetLimits.tokenBudget));
  check("recover: autoRenewals +1", (g.autoRenewals ?? 0) === 1, String(g.autoRenewals));
  check("recover: 幂等（再调一次 no-op）",
    goalManager.autoRecoverBudget("runtime") === null &&
      (goalManager.getGoal().autoRenewals ?? 0) === 1,
    String(goalManager.getGoal().autoRenewals));
}

reset();
{
  restoreLimited(900_000, 800_000, { budgetLimits: { tokenBudget: 800_000, turnBudget: 3 }, turnsUsed: 9 });
  check("recover: turn 越界不复活", goalManager.autoRecoverBudget("runtime") === null &&
    goalManager.getGoal().status === "budget_limited",
    goalManager.getGoal().status);
}

reset({ PI_LAMBOY_GOAL_MAX_TOKENS: 1_000_000 });
{
  restoreLimited(1_100_000, 800_000);
  check("recover: 超过总预算上限不复活",
    goalManager.autoRecoverBudget("runtime") === null &&
      goalManager.getGoal().status === "budget_limited",
    goalManager.getGoal().status);
}

reset();
{
  restoreLimited(500_000, 800_000); // 用户已括号提额但未 resume
  const r = goalManager.autoRecoverBudget("runtime");
  check("recover: 预算已覆盖用量 → 只 resume 不扩",
    r?.extended === false && r.resumed === true &&
      goalManager.getGoal().status === "active" &&
      goalManager.getGoal().budgetLimits.tokenBudget === 800_000,
    JSON.stringify({ r, s: goalManager.getGoal().status }));
}

reset({ PI_LAMBOY_GOAL_AUTORENEW: 0 });
{
  restoreLimited(900_000, 800_000);
  check("recover: 关闭自动续接时不动",
    goalManager.autoRecoverBudget("runtime") === null &&
      goalManager.getGoal().status === "budget_limited",
    goalManager.getGoal().status);
}

reset();
{
  goalManager.createGoal("recover active probe", undefined, { tokenBudget: 800_000 }, "user");
  check("recover: active 且未超限 → no-op", goalManager.autoRecoverBudget("runtime") === null);
}

// Finding 2 (review 2026-10-28): active 但超预算时，恢复前必须把在途
// wall-clock 区间折进 wallClockMs，否则 wallClockBudgetMs 会少算。
reset();
{
  goalManager.clear();
  const nowMs = Date.now();
  goalManager.restoreFromData({
    goalId: "g-recover-wallclock", objective: "wallclock probe", status: "active",
    lastActor: "runtime", lastActedAt: new Date(nowMs).toISOString(), turnsUsed: 3,
    tokensUsed: 900_000, wallClockMs: 10_000,
    wallClockResumedAt: nowMs - 5_000,
    budgetLimits: { tokenBudget: 800_000 },
  });
  const r = goalManager.autoRecoverBudget("runtime");
  const g = goalManager.getGoal();
  check("recover wallclock: 扩容恢复", r?.extended === true, JSON.stringify(r));
  check("recover wallclock: 在途 5s 折入 wallClockMs",
    g.wallClockMs >= 14_500 && g.wallClockMs <= 16_500,
    String(g.wallClockMs));
  check("recover wallclock: 区间从恢复时刻重新计时",
    typeof g.wallClockResumedAt === "number" && Date.now() - g.wallClockResumedAt < 1_000,
    String(g.wallClockResumedAt));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
