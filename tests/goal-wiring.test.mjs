// B2 tool_call 硬拦截 + A2 委派记账 —— 真实扩展入口接线测试（stub pi，零模型配额）。
//
// spec: plans/2026-10-19-goal-delegation-and-budget-continuation.md §2-A2 / §3-B2
//   A2. turn_end 从 event.toolResults[].usage 把 subagent child tokens 记入
//       goal 预算（recordTokenUsage，不加 turnsUsed）；非 subagent 工具不计。
//   B2. shouldBlockTool 经 tool_call 事件接线：budget/usage limited 状态下
//       block 白名单（get_goal/update_goal/handoff）之外的一切工具；
//       env PI_LAMBOY_GOAL_TOOL_GATE=0 关闭。
//
// 与 goal-429-recovery.test.mjs 同模式：native ESM 直接 import（node 26 原生
// strip-types），扩展入口带 cache-busting query 独立求值，core 单例共享。

import assert from "node:assert/strict";

const { goalManager } = await import("../packages/core/goal/index.ts");

const mod = await import(`../extensions/40-goal.ts?case=wiring`);
assert.equal(typeof mod.default, "function", "40-goal.ts must default-export a factory");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const sessionEntries = [];
const ctx = {
  sessionManager: { getEntries: () => sessionEntries },
  ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, t) => t } },
};

const handlers = new Map();
const tools = new Map();
const pi = {
  on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); },
  registerTool: (def) => tools.set(def.name, def),
  registerCommand: () => {},
  appendEntry: (type, data) => sessionEntries.push({ type: "custom", customType: type, data }),
};
mod.default(pi);

const toolCallHandlers = () => handlers.get("tool_call") ?? [];
const turnEndHandlers = () => handlers.get("turn_end") ?? [];
check("tool_call handler registered (B2 wiring)", toolCallHandlers().length >= 1);

async function fireToolCall(toolName, input = {}) {
  let result;
  for (const fn of toolCallHandlers()) {
    const r = await fn({ toolName, input }, ctx);
    if (r !== undefined) result = r;
  }
  return result;
}
async function fireTurnEnd(event) {
  for (const fn of turnEndHandlers()) await fn(event, ctx);
}

function freshGoal(status) {
  goalManager.clear();
  goalManager.createGoal("wiring probe", undefined, { tokenBudget: 50000 }, "user");
  if (status === "budget_limited") goalManager.markBudgetLimited("tokenBudget exceeded");
  if (status === "usage_limited") goalManager.markUsageLimited("429");
  if (status === "paused") goalManager.pause("user");
}

// ── B2. 预算耗尽 → 硬拦截（默认开） ───────────────────────────────────
freshGoal("budget_limited");
{
  const blockedRead = await fireToolCall("read", { path: "x.ts" });
  check("B2 budget_limited 阻塞 read，返回 {block, reason}",
    blockedRead?.block === true && /budget_limited|handoff/i.test(String(blockedRead?.reason)),
    JSON.stringify(blockedRead));

  for (const allowed of ["get_goal", "update_goal", "handoff"]) {
    const r = await fireToolCall(allowed);
    check(`B2 budget_limited 放行白名单 ${allowed}`, r === undefined, JSON.stringify(r));
  }
}

freshGoal("usage_limited");
{
  const r = await fireToolCall("bash", { command: "ls" });
  check("B2 usage_limited 阻塞 bash", r?.block === true, JSON.stringify(r));
  const h = await fireToolCall("handoff", { prompt: "brief" });
  check("B2 usage_limited 放行 handoff", h === undefined, JSON.stringify(h));
}

freshGoal("active");
{
  const r = await fireToolCall("bash", { command: "ls" });
  check("B2 active 不阻塞 bash", r === undefined, JSON.stringify(r));
  const w = await fireToolCall("subagent", { agent: "scout", task: "x" });
  check("B2 active 不阻塞 subagent（委派通道畅通）", w === undefined, JSON.stringify(w));
}

freshGoal("paused");
{
  const r = await fireToolCall("write", { path: "x", content: "y" });
  check("B2 paused 不拦截（拦截仅限 budget/usage limited）", r === undefined, JSON.stringify(r));
}

// ── B2b. env PI_LAMBOY_GOAL_TOOL_GATE=0 关闭硬拦截 ─────────────────────
process.env.PI_LAMBOY_GOAL_TOOL_GATE = "0";
{
  const mod2 = await import(`../extensions/40-goal.ts?case=wiring-gate-off`);
  const handlers2 = new Map();
  const pi2 = {
    on: (ev, fn) => { if (!handlers2.has(ev)) handlers2.set(ev, []); handlers2.get(ev).push(fn); },
    registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {},
  };
  mod2.default(pi2);
  freshGoal("budget_limited");
  const tc2 = handlers2.get("tool_call") ?? [];
  let r;
  if (tc2.length > 0) r = await tc2[0]({ toolName: "read", input: {} }, ctx);
  check("B2b TOOL_GATE=0 → 不注册拦截（或放行）",
    tc2.length === 0 || r === undefined, JSON.stringify({ n: tc2.length, r }));
}
delete process.env.PI_LAMBOY_GOAL_TOOL_GATE;

// ── A2. turn_end toolResults 记账：subagent child tokens 计入预算 ─────
{
  goalManager.clear();
  goalManager.createGoal("accounting probe", undefined, { tokenBudget: 800000 }, "user");
  await fireTurnEnd({
    message: { role: "assistant", stopReason: "stop", usage: { input: 100, output: 50 } },
    toolResults: [
      { role: "toolResult", toolName: "subagent", usage: { input: 1000, output: 500 } },
      { role: "toolResult", toolName: "web_search", usage: { input: 999, output: 99 } },
      { role: "toolResult", toolName: "subagent", usage: undefined },
    ],
  });
  const g = goalManager.getGoal();
  check("A2 subagent usage 计入（150+1500=1650），非 subagent 不计",
    g?.tokensUsed === 1650, String(g?.tokensUsed));
  check("A2 turnsUsed 仍为 1（父 turn 语义不变）", g?.turnsUsed === 1, String(g?.turnsUsed));
  check("A2 无 usage 的 toolResult 不崩溃且不记账", g?.status === "active", g?.status);
}

// A2b. 缺 toolResults 字段（老 pi / 429 测试事件形状）不崩溃
{
  goalManager.clear();
  goalManager.createGoal("no-toolResults probe", undefined, { tokenBudget: 800000 }, "user");
  await fireTurnEnd({
    message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5 } },
  });
  check("A2b 无 toolResults 字段安全", goalManager.getGoal()?.tokensUsed === 15,
    String(goalManager.getGoal()?.tokensUsed));
}

// A2c. 预算跨越判定：handler 先记 msg（1000 未跨）再记 child（1500，跨越 2000）
// → budget_limited（总消耗 2500）。
{
  goalManager.clear();
  goalManager.createGoal("crossing probe", undefined, { tokenBudget: 2000 }, "user");
  await fireTurnEnd({
    message: { role: "assistant", stopReason: "stop", usage: { input: 800, output: 200 } },
    toolResults: [
      { role: "toolResult", toolName: "subagent", usage: { input: 900, output: 600 } },
    ],
  });
  const g = goalManager.getGoal();
  check("A2c child 1500 后记入，msg 1000 已先记 → 跨越 2000 进 budget_limited（总消耗 2500）",
    g?.tokensUsed === 2500 && g?.status === "budget_limited",
    JSON.stringify({ t: g?.tokensUsed, s: g?.status }));
}

// A2d. Finding 1 盲区修复：msg 先跨限（budget_limited），同 turn 的委派 token 仍入账
{
  goalManager.clear();
  goalManager.createGoal("msg-first crossing probe", undefined, { tokenBudget: 2000 }, "user");
  await fireTurnEnd({
    message: { role: "assistant", stopReason: "stop", usage: { input: 1500, output: 600 } },
    toolResults: [
      { role: "toolResult", toolName: "subagent", usage: { input: 100, output: 100 } },
    ],
  });
  const g = goalManager.getGoal();
  check("A2d msg 先跨限 → budget_limited，委派 200 tokens 仍入账（总 2300）",
    g?.status === "budget_limited" && g?.tokensUsed === 2300,
    JSON.stringify({ s: g?.status, t: g?.tokensUsed }));
}

goalManager.clear();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
