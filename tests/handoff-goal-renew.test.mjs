// handoff 预算联动 —— 纯 core 单测（不启动真实 session）。
//
// 修复目标：/handoff 用 ctx.newSession({ parentSession }) 切换后，goal 仍是
// 同一个进程级单例（budget_limited + tokensUsed 已超预算），新 session 首
// turn 立刻被 wrap-up/工具门拦住。renewForHandoff() 负责：
//   1. tokenBudget 抬到 max(used + step, ceil(used*1.25/50k)*50k)
//   2. budget_limited → active
//   3. 通过新 session 的 appendCustomEntry 落盘（旧 pi.appendEntry 已失效）
//
// env:
//   PI_LAMBOY_HANDOFF_GOAL_RENEW=0  关闭 handoff 预算联动
//   PI_LAMBOY_GOAL_MAX_TOKENS       总预算硬上限（默认 8M）

import assert from "node:assert/strict";

const { goalManager } = await import("../packages/core/goal/index.ts");
const { GOAL_ENTRY_TYPE } = await import("../packages/core/goal/types.ts");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const ENV_KEYS = [
  "PI_LAMBOY_HANDOFF_GOAL_RENEW",
  "PI_LAMBOY_GOAL_MAX_TOKENS",
  "PI_LAMBOY_GOAL_EXTEND_STEP",
  "PI_LAMBOY_GOAL_RENEW_STEP",
  "PI_LAMBOY_GOAL_AUTORENEW",
  "PI_LAMBOY_GOAL_AUTORENEW_MAX",
];
function reset(env = {}) {
  goalManager.clear();
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
}
function expectedBudget(used, step = 800_000) {
  return Math.max(used + step, Math.ceil((used * 1.25) / 50_000) * 50_000);
}

// ── 1. budget_limited → 扩容 + 恢复 active + 新 session 落盘 ─────────
reset();
{
  const used = 900_000;
  goalManager.restoreFromData({
    goalId: "g-handoff-1", objective: "handoff renew probe", status: "budget_limited",
    lastActor: "runtime", lastActedAt: new Date().toISOString(), turnsUsed: 10,
    tokensUsed: used, wallClockMs: 0, budgetLimits: { tokenBudget: 800_000 },
    terminalReason: "Budget exceeded",
  });

  const appended = [];
  const r = goalManager.renewForHandoff((type, data) => appended.push({ type, data }));

  const g = goalManager.getGoal();
  check("handoff: goal resumed active", g.status === "active", g.status);
  check("handoff: budget extended",
    g.budgetLimits.tokenBudget === expectedBudget(used),
    `${g.budgetLimits.tokenBudget} vs ${expectedBudget(used)}`);
  check("handoff: returns renewed+resumed",
    r.renewed === true && r.resumed === true && r.newBudget === expectedBudget(used),
    JSON.stringify(r));
  check("handoff: persisted through new-session append",
    appended.length === 1 && appended[0].type === GOAL_ENTRY_TYPE &&
    appended[0].data.budgetLimits.tokenBudget === expectedBudget(used),
    JSON.stringify(appended));
  check("handoff: entry keeps cumulative tokensUsed",
    appended[0].data.tokensUsed === used, String(appended[0].data.tokensUsed));
}

// ── 2. env 关闭 → 不扩容、不恢复，但也不丢 goal ─────────────────────
reset({ PI_LAMBOY_HANDOFF_GOAL_RENEW: 0 });
{
  goalManager.restoreFromData({
    goalId: "g-handoff-2", objective: "handoff renew off probe", status: "budget_limited",
    lastActor: "runtime", lastActedAt: new Date().toISOString(), turnsUsed: 10,
    tokensUsed: 900_000, wallClockMs: 0, budgetLimits: { tokenBudget: 800_000 },
    terminalReason: "Budget exceeded",
  });
  const appended = [];
  const r = goalManager.renewForHandoff((type, data) => appended.push({ type, data }));
  const g = goalManager.getGoal();
  check("handoff off: stays budget_limited", g.status === "budget_limited", g.status);
  check("handoff off: budget unchanged", g.budgetLimits.tokenBudget === 800_000,
    String(g.budgetLimits.tokenBudget));
  check("handoff off: no renewal reported", r.renewed === false, JSON.stringify(r));
}

// ── 3. complete / 无 goal → 无副作用 ────────────────────────────────
reset();
{
  goalManager.createGoal("handoff complete probe", undefined, { tokenBudget: 800_000 }, "user");
  goalManager.complete("user");
  const appended = [];
  const r = goalManager.renewForHandoff((type, data) => appended.push({ type, data }));
  check("handoff complete: no-op", r.renewed === false && appended.length === 0,
    JSON.stringify({ r, appended }));
}

// ── 4. 总预算硬上限：used 已超 8M → 不再扩容 ───────────────────────
reset({ PI_LAMBOY_GOAL_MAX_TOKENS: 8_000_000 });
{
  goalManager.restoreFromData({
    goalId: "g-handoff-4", objective: "handoff total cap probe", status: "budget_limited",
    lastActor: "runtime", lastActedAt: new Date().toISOString(), turnsUsed: 100,
    tokensUsed: 8_200_000, wallClockMs: 0, budgetLimits: { tokenBudget: 8_000_000 },
    terminalReason: "Budget exceeded",
  });
  const appended = [];
  const r = goalManager.renewForHandoff((type, data) => appended.push({ type, data }));
  const g = goalManager.getGoal();
  check("handoff cap: stays budget_limited", g.status === "budget_limited", g.status);
  check("handoff cap: budget unchanged", g.budgetLimits.tokenBudget === 8_000_000,
    String(g.budgetLimits.tokenBudget));
  check("handoff cap: renewed=false", r.renewed === false, JSON.stringify(r));
  check("handoff cap: still persists goal to new session",
    appended.length === 1 && appended[0].type === GOAL_ENTRY_TYPE,
    JSON.stringify(appended));
}

// ── 5. under-budget active goal：handoff 只扩容（幂等、不清计数器）──
reset();
{
  goalManager.createGoal("handoff active probe", undefined, { tokenBudget: 500_000 }, "user");
  goalManager.recordTurn(100_000);
  const before = goalManager.getGoal();
  const appended = [];
  const r = goalManager.renewForHandoff((type, data) => appended.push({ type, data }));
  const g = goalManager.getGoal();
  check("handoff active: keeps active and accounting",
    g.status === "active" && g.turnsUsed === before.turnsUsed && g.tokensUsed === before.tokensUsed,
    JSON.stringify({ status: g.status, turns: g.turnsUsed, tokens: g.tokensUsed }));
  check("handoff active: extends to the renewal formula",
    r.renewed === true && g.budgetLimits.tokenBudget === expectedBudget(100_000),
    JSON.stringify({ r, b: g.budgetLimits.tokenBudget }));
  check("handoff active: logs a fresh entry", appended.length === 1, String(appended.length));
}

// ── 6. turn/wall-clock 耗尽：handoff 不扩容、不 resume（换会话不解决）──
reset();
{
  goalManager.restoreFromData({
    goalId: "g-handoff-6", objective: "handoff turn-exhausted probe", status: "budget_limited",
    lastActor: "runtime", lastActedAt: new Date().toISOString(), turnsUsed: 5,
    tokensUsed: 900_000, wallClockMs: 0,
    budgetLimits: { tokenBudget: 800_000, turnBudget: 5 },
    terminalReason: "Budget exceeded",
  });
  const appended = [];
  const r = goalManager.renewForHandoff((type, data) => appended.push({ type, data }));
  const g = goalManager.getGoal();
  check("handoff turn-exhausted: no resume",
    g.status === "budget_limited" && r.resumed === false,
    JSON.stringify({ status: g.status, r }));
  check("handoff turn-exhausted: no extension",
    g.budgetLimits.tokenBudget === 800_000 && r.renewed === false,
    JSON.stringify({ b: g.budgetLimits.tokenBudget, r }));
  check("handoff turn-exhausted: goal still persisted",
    appended.length === 1 && appended[0].type === GOAL_ENTRY_TYPE,
    JSON.stringify(appended));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
