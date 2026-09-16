// 429 usage_limited 自恢复 —— 端到端锁定测试（真实扩展入口 + stub pi）。
//
// 事故复现（quant02 2026-09-16 session 02:40:50, jdcloud GLM-5.3）:
//   04:24:48 三连 429（"tokens limit for minute"）→ goal 正确标记 usage_limited
//   06:02–06:07 五轮用户「继续执行」、甚至原样贴出 update_goal(status="active")，
//   模型 thinking 均引述注入文案 "tool calls are blocked / once the window
//   clears, I may call update_goal" → 拒绝调用任何工具，goal 卡死在 usage_limited。
//
// 修复锁定:
//   R1. usage_limited 注入文案改为「恢复教学」: 明示 get_goal/update_goal
//       始终可用 + 「能生成本回复 = 限流窗已过」+ 立即 update_goal(status="active")。
//   R2. turn_end 自愈: 健康 assistant turn（stopReason 非 error）意味着 provider
//       已恢复服务（活跃 429 会令生成本身失败）→ 自动 resume, 不依赖模型自觉。
//       budget_limited 不自愈（用户保留决策, tokensUsed 单调）。
//   R3. 错误 turn（429 errorMessage）→ 仍标记 usage_limited（检测路径不回归）。
//   R4. session_start 从条目恢复 usage_limited goal（真实恢复路径）。

import assert from "node:assert/strict";

const { GOAL_ENTRY_TYPE } = await import("../packages/core/goal/types.ts");
// 与 40-goal.ts 内部同一解析 URL → 同一模块实例（native ESM 按绝对 URL 缓存）
const { goalManager } = await import("../packages/core/goal/index.ts");

// cache-busting query —— 与 handoff/sanitize 测试同模式
const mod = await import(`../extensions/40-goal.ts?case=429-recovery`);
assert.equal(typeof mod.default, "function", "40-goal.ts must default-export a factory");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const notified = [];
const sessionEntries = [];
const ctx = {
  sessionManager: { getEntries: () => sessionEntries },
  ui: {
    setStatus: () => {},
    notify: (msg, level) => notified.push([msg, level]),
    theme: { fg: (_c, t) => t },
  },
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

// ── R4. 真实恢复路径: session 条目里的 usage_limited goal ──
sessionEntries.push({
  type: "custom", customType: GOAL_ENTRY_TYPE,
  data: {
    goalId: "g-429", objective: "probe: quant02 429 recovery", status: "usage_limited",
    lastActor: "runtime", lastActedAt: 0, turnsUsed: 3, tokensUsed: 1000,
    wallClockMs: 60000, wallClockResumedAt: undefined, budgetLimits: undefined,
    terminalReason: '429: {"cause":"tokens limit for minute"}',
  },
});
await handlers.get("session_start")[0]({}, ctx);
check("session_start restores usage_limited goal",
  goalManager.getGoal()?.status === "usage_limited", goalManager.getGoal()?.status);

// ── R1. 注入文案: 教恢复, 不吓阻 ──
{
  const messages = [];
  await handlers.get("context")[0]({ messages }, ctx);
  const inj = messages[messages.length - 1]?.content?.[0]?.text ?? "";
  check("injection teaches update_goal(status=\"active\")",
    /update_goal\(status="active"\)/.test(inj), JSON.stringify(inj.slice(0, 140)));
  check("injection no longer claims blanket 'Tool calls are blocked'",
    !/Tool calls are blocked/.test(inj), JSON.stringify(inj.slice(0, 140)));
  check("injection gives observable recovery cue (generating this response)",
    /generating this/i.test(inj), "");
  check("injection still forbids create_goal",
    /Do NOT call create_goal/.test(inj), "");
}

// ── R3. 错误 turn (429): 检测路径不回归, 保持 usage_limited ──
{
  await handlers.get("turn_end")[0]({
    message: {
      role: "assistant", stopReason: "error", usage: { input: 0, output: 0 },
      errorMessage: '429: {"cause":"tokens limit for minute","code":429,"status":"RATE_LIMIT"}',
    },
  }, ctx);
  check("429 error turn keeps goal usage_limited",
    goalManager.getGoal()?.status === "usage_limited", goalManager.getGoal()?.status);
}

// ── R2. 健康 turn: turn_end 自愈 resume ──
{
  await handlers.get("turn_end")[0]({
    message: { role: "assistant", stopReason: "stop", usage: { input: 120, output: 80 } },
  }, ctx);
  check("healthy turn auto-resumes usage_limited goal",
    goalManager.getGoal()?.status === "active", goalManager.getGoal()?.status);
  check("auto-resume notified to user",
    notified.some(([m]) => /auto-resume/i.test(m)), JSON.stringify(notified.slice(-3)));
  check("auto-resumed goal continues counting turns",
    (goalManager.getGoal()?.turnsUsed ?? 0) >= 4, String(goalManager.getGoal()?.turnsUsed));
}

// ── R2b. 自愈不影响 budget_limited（用户保留决策） ──
{
  goalManager.clear();
  goalManager.createGoal("budget probe");
  goalManager.markBudgetLimited("tokenBudget exceeded");
  await handlers.get("turn_end")[0]({
    message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 10 } },
  }, ctx);
  check("healthy turn does NOT auto-resume budget_limited",
    goalManager.getGoal()?.status === "budget_limited", goalManager.getGoal()?.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
