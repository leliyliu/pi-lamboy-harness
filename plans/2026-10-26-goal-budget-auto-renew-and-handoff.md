# 设计：Goal 预算自动续接 + handoff 预算窗口联动

> 日期：2026-10-26 · 状态：**已实现（待 reviewer 复核）** · 目标读者：仓库所有者
> 前置：`plans/2026-10-19-goal-delegation-and-budget-continuation.md`（B1-B4 已落地）
> 本文只解决用户当前反馈的两个问题：① budget 耗尽必须手动 `/goal resume`；② `/handoff` 切到新 session 后预算不扩展，仍旧卡在 budget_limited。

---

## 0. TL;DR

- **问题 1 的根因不是 resume 逻辑缺失，而是"续接入口只有用户命令"**：`autoExtend` 是 `create_goal` 的可选参数且默认 `false`，`top-up` 只在 `/goal resume` 里触发。历史 126 个 goal 中 **0 个** `autoExtend=true`，说明这条路实际从未被用上。
- **问题 2 的根因是 goal 是进程级单例，handoff 不重置也不扩展它**：`ctx.newSession()` 只创建新 session 文件（header 里一个 `parentSession` 字段），**不复制** 旧 session 的 goal entries；但同一进程内 `goalManager` 单例继续持有旧 goal（budget_limited + `tokensUsed` 已超预算）。于是新 session 首 turn 就命中 wrap-up 注入与 tool gate，等于把"预算耗尽"原样搬到新会话。
- 建议：**自动续接（耗尽即扩预算继续，带安全阀）+ handoff 切换时显式扩展预算并把 goal 落盘到新 session**。两处都不依赖模型自觉，全部走 runtime。

---

## 1. 证据链

### 1.1 当前预算/续接机制（代码事实）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 记账口径 = 每 turn 的 `usage.input + usage.output`，不含 cacheRead/cacheWrite | `extensions/40-goal.ts:166` |
| 2 | 子代理 token 在 turn_end 从 `toolResults[].usage` 汇总后记账 | `extensions/40-goal.ts:185-210` |
| 3 | 超预算 → `budget_limited`（非 token 预算 → `blocked`） | `packages/core/goal/index.ts:369-398` |
| 4 | `autoExtend` 为 `create_goal` 第 6 个可选参数，默认 `false`；只有显式传 true 才在 token 越界时自动扩容 | `packages/core/goal/index.ts:70-99, 363-381` |
| 5 | `/goal resume` 才会自动 top-up；top-up 次数默认上限 **3 次**，步长 500k，公式 `max(used+500k, used*1.25 上取整 50k)` | `packages/core/goal/index.ts:559-637`、`packages/core/goal/commands.ts:37-57` |
| 6 | budget_limited 期间 `shouldBlockTool` 只放行 `get_goal / handoff / update_goal`，且已在 `tool_call` 事件硬接线 | `packages/core/goal/types.ts:108-110`、`extensions/40-goal.ts:124-145` |
| 7 | wrap-up 注入要求模型先写 handoff 草稿，续跑仍留给用户 | `packages/core/goal/index.ts:640-692` |

### 1.2 `/handoff` 之后的 goal 归属（代码事实）

| # | 事实 | 证据 |
|---|---|---|
| 1 | handoff 用 `ctx.newSession({ parentSession })` 切换会话 | `handoff/commands.ts:145-157` |
| 2 | `newSession` 只新建 session header（含 `parentSession` 元数据），`fileEntries` 重置为 `[header]`，**不复制** 旧 entries | `pi-coding-agent/dist/core/session-manager.js:645-670` |
| 3 | goal 状态是模块级单例 `goalState`，跨 session 保留 | `packages/core/goal/types.ts`（`goalState`）、`packages/core/goal/index.ts:1083` |
| 4 | `session_start` 只做"有 entry 就恢复"，**没有** 在无 goal 的新 session 里清空内存 goal | `extensions/40-goal.ts:45-56`、`packages/core/goal/persistence.ts:77-110` |
| 5 | 全仓没有任何 `session_shutdown`/session 切换处的 goal 重置或迁移逻辑 | `rg -n "session_shutdown" packages extensions handoff` 仅命中 `extensions/60-todo.ts:40` 与测试 |
| 6 | 结论：handoff 后新 session = 空 entries + 旧内存 goal；重启进程反而会丢 goal（新 session 没有 goal entry） | 1.2#2 + 1.2#4 + 1.2#5 |

**这解释用户观察到的"类似 fork，但不能扩展预算"**：fork 的是进程内 goal 对象，不是 session entries；预算数字和 `tokensUsed` 原封不动跟过去。

### 1.3 历史 session 实测（`~/.pi/agent/sessions`，93 个含 goal 的 session / 126 个 goal）

| 指标 | 数值 |
|---|---|
| status 分布 | complete 70、budget_limited 12、active 10、usage_limited 1 |
| `autoExtend=true` 的 goal | **0** |
| `topUps>0`（手动 resume 过）的 goal | 7 |
| 平均记账速率 | ~9.7k tokens/turn → 800k 约撑 **82 turns** |
| 最重的 budget_limited 样本 | 34.3k tokens/turn → 800k 只撑 **23 turns** |
| 典型 budget_limited 样本 | budget 800k、used 889k、128 turns；budget 1.2M、used 1.24M、249 turns |

结论：800k 默认值对"长任务 + 富上下文"确实不够；但更关键的是**耗尽后没有任何自动继续的路径**（0 次 autoExtend）。

---

## 2. 方案

### 2.1 自动续接（auto-renew）

**行为**：`recordTurn` / `recordTokenUsage` 判定 token 越界时，若自动续接开启：

1. 按既有公式扩展 `autoRenewBudget`：`next = max(used + step, ceil(used*1.25/50k)*50k)`，`step = PI_LAMBOY_GOAL_RENEW_STEP` 默认 800k；若 `PI_LAMBOY_GOAL_MAX_TOKENS > 0` 则 `next = min(next, cap)`，且 `used >= cap` 时不扩展。
2. goal 保持 `active`，`autoRenewals++`，runtime 通知一次（"预算自动续接到 X（#n）"）。
3. 安全阀：单 goal 总预算上限 `PI_LAMBOY_GOAL_MAX_TOKENS`（默认 8M）。达到上限后停止自动续接，落回 `budget_limited`（此时才需要人工 `/goal resume` 或 `/handoff`）。
4. 自动续接不消耗 `/goal resume` 的 3 次上限（两条计数器分开），避免"自动用掉用户手动额度"。
5. 总开关：`PI_LAMBOY_GOAL_AUTORENEW=0` 关闭（默认开）。
6. 旧 `autoExtend=true` 路径仍用 `topUps` 计数 + `PI_LAMBOY_GOAL_EXTEND_STEP`（默认 500k）；当 topUp 用满时，同一次 token 越界由 auto-renew 接手（fall-through，不是停机）。

**不改**：
- `usage_limited`（429）自愈路径完全不动。
- LLM 侧 `update_goal(status=active)` 仍然不能自行解除 budget_limited（防止模型自我放行）。

**为什么不是把 `autoExtend` 默认改成 true**：`autoExtend` 复用 `/goal resume` 的 `topUps` 计数器（默认 3 次），3 次之后照样卡死；且它是 per-goal 参数，历史 goal 无法追溯。自动续接作为 runtime 策略，语义更清楚、可全局关闭、可设总上限。

### 2.2 handoff 预算窗口联动

**行为**：`handoff/commands.ts` 的 `withSession` 回调里（新 session 已生效、旧 ctx 已失效）调用新 API：

```ts
goalManager.onSessionHandoff({ step: 800_000, resume: true });
```

1. 若存在未完成 goal 且未被 turn/wall-clock 预算耗尽：把 `tokenBudget` 至少抬到 `max(tokensUsed + step, ceil(tokensUsed*1.25/50k)*50k)`，受 8M 总上限约束（`step` 默认 800k）。
2. 仅当 `status === "budget_limited"` 且预算**确实扩展**时恢复 `active`（turn/wall-clock 耗尽或已达 8M 总上限时保持原状态——换 session 不解决这些预算）。
3. **立即 `persist()` 到新 session**：通过 `SessionManager.appendCustomEntry` 写入 goal entry，修复"handoff 后重启丢 goal"的缺陷。
4. `tokensUsed` 不归零（保留连续账单），只在通知里显示"本次 handoff 追加预算 X，累计已用 Y"。
5. 开关：`PI_LAMBOY_HANDOFF_GOAL_RENEW=0` 关闭（默认开，跟随 `PI_LAMBOY_GOAL_AUTORENEW` 总开关）；handoff 扩容不消耗 auto-renew 次数上限。

**可选增强**：handoff prompt 的 footer 已经带 parent session 路径（`packages/core/handoff/prompt.ts`），可在 footer 追加一行 goal objective / completion criterion，降低新 session 重新对齐成本。

### 2.3 顺手修复（低风险）

- `session_start` 恢复逻辑：区分"新 session 无 goal entry"与"从旧 session 恢复"。当前依赖内存单例，若进程重启 + handoff 新 session，goal 直接消失。2.2#3 的立即落盘即可解决主路径；再加一条：handoff 后把 goal entry 写进新 session 的 head，属于同一改动。

---

## 3. 待决策点（需用户拍板）

### D1. 自动续接的默认形态

| 选项 | 行为 | 风险 |
|---|---|---|
| A（推荐） | 每次耗尽自动 +800k，最多 10 次（≈8.8M 总量），之后停下提示 | 成本可控，仍可能中断 |
| B | 自动 +800k，不设次数上限，只靠 `PI_LAMBOY_GOAL_MAX_TOKENS` 兜底 | 最省心，但可能长时间无人值守烧钱 |
| C | 每次耗尽弹一次确认再扩 | 仍需交互，违背"自动化"诉求 |
| D | 不改自动续接，只把默认预算提高到 2M | 改动最小，但长任务仍会撞墙 |

### D2. handoff 后的预算语义

| 选项 | 行为 | 权衡 |
|---|---|---|
| A（推荐） | 保留 `tokensUsed` 累计，`tokenBudget` 抬到 `used + 800k` | 账单连续，语义直观，改动最小 |
| B | `tokensUsed` 归零开新窗口，累计值另存 | "每个 session 一份预算"，但历史账单被割裂 |
| C | handoff 不碰预算，完全交给 2.1 自动续接 | 职责单一，但 handoff 当下仍可能处于 budget_limited 一瞬间 |

### D3. 总预算安全阀

| 选项 | 行为 |
|---|---|
| A（推荐） | 单个 goal 总预算上限 8M tokens，到达后停止自动续接并提示 |
| B | 不设上限，只通知 |
| C | 上限 2M（更保守） |

---

## 4. 验收标准

1. **自动续接**：单测模拟 `recordTurn` 越过 tokenBudget → status 仍 `active`、`tokenBudget` 增加、`topUps` 不增加、通知回调触发；达到 `PI_LAMBOY_GOAL_MAX_TOKENS` 后 → `budget_limited`。
2. **开关**：`PI_LAMBOY_GOAL_AUTORENEW=0` 时行为与现状完全一致（回归旧测试不改）。
3. **handoff 联动**：单测构造 budget_limited goal → 调 `onSessionHandoff()` → status=`active`、budget ≥ used+step、persist 被调用一次。
4. **handoff 落盘**：模拟新 session（空 entries）→ 调 `onSessionHandoff()` → 断言新 entries 中出现 `lamboy_goal` entry，且重启恢复后 goal 仍存在。
5. **全量回归**：`npm test` 全绿；`npm run typecheck` 通过。
6. **实机 smoke**：长任务跑到耗尽 → 不中断继续；`/handoff` 后新 session 首 turn 无 tool gate 拦截，goal 预算显示为扩展后的值。

---

## 5. 已确认决策（2026-10-26）

- **D1 = A**：自动续接默认开，每次 +800k，最多 **10 次**。
- **D2 = A**：handoff 保留 `tokensUsed` 累计，`tokenBudget` 抬到 `used + 800k`，自动恢复 active。
- **D3 = A**：单 goal 总预算硬上限 **8M**，到达后停止自动续接并落回 `budget_limited`。

---

## 6. 实施计划（文件级）

### 6.1 数据模型

**`packages/core/goal/types.ts`**
- `GoalSnapshot` 增加 `autoRenewals?: number`（自动续接次数，独立于 `topUps`）。
- `GoalEntryData` 增加同字段。

**`packages/core/goal/persistence.ts`**
- `goalToEntryData` / `goalFromEntryData` 透传 `autoRenewals`。

### 6.2 自动续接（core）

**`packages/core/goal/index.ts`**

新增私有策略读取（全部在调用时读 env，便于测试覆盖）：
- `autoRenewEnabled()`：`PI_LAMBOY_GOAL_AUTORENEW !== "0"`（默认开）。
- `autoRenewMax()`：`PI_LAMBOY_GOAL_AUTORENEW_MAX`，默认 `10`，`0` = 不限。
- `maxTotalTokens()`：`PI_LAMBOY_GOAL_MAX_TOKENS`，默认 `8_000_000`，`0` = 不限。
- `renewStep()`：`PI_LAMBOY_GOAL_RENEW_STEP`，默认 `800_000`（旧 autoExtend 仍用 `extendStep()` 默认 500k）。

修改 `recordTurn()` / `recordTokenUsage()` 的越界分支：
1. 先判定 `crossedTurns` / `crossedWallClock`（非 token 预算仍直接停，不消耗自动续接）。
2. 纯 token 越界时按优先级选择：`autoExtend === true`（旧路径，仍走 `topUps` 计数）→ 否则 auto-renew 策略。
3. auto-renew 扩展公式：`next = max(newTokens + step, ceil(newTokens*1.25/50k)*50k)`；若 `maxTotalTokens > 0` 则 `next = min(next, cap)`；若 `newTokens >= cap` → 不扩展，落 `budget_limited`。
4. 扩展成功：`status = active`、`budgetLimits.tokenBudget = next`、`autoRenewals++`。
5. 返回值增加可选 `autoRenewed?: { budget: number; count: number }`；`crossedBudget=false`（goal 未停止）。旧字段 `autoExtendedTo` 对两条路径都填，兼容现有测试/适配器。

### 6.3 handoff 联动（core + adapter）

**`packages/core/goal/index.ts`** 新增公开方法：

```ts
renewForHandoff(append?: (type: string, data: unknown) => void): {
  renewed: boolean; newBudget?: number; resumed: boolean;
}
```

行为：
- goal 不存在 / 已 complete → 直接返回（不创建 goal）。
- 有 tokenBudget 且开关开启（`PI_LAMBOY_HANDOFF_GOAL_RENEW !== "0"` 且 `PI_LAMBOY_GOAL_AUTORENEW !== "0"`）→ 抬到 `max(used + step, ceil(used*1.25/50k)*50k)`，并受 8M 总上限约束。
- `status === "budget_limited"` → 恢复 `active`（清 `terminalReason`、重置 `wallClockResumedAt`）。
- **持久化走传入的 `append`**（新 session 的 `SessionManager.appendCustomEntry`），因为旧 `pi.appendEntry` 仍指向已 dispose 的 session。

**`handoff/commands.ts`** `reviewAndSwitch()`：把 `ctx.newSession()` 改为同时传 `setup`：

```ts
setup: async (sm) => {
  try {
    goalManager.renewForHandoff((t, d) => sm.appendCustomEntry(t, d));
  } catch { /* never break handoff */ }
}
```

`setup` 在 session_start 之后、`withSession` 之前执行，且拿到可写 `SessionManager`（`docs/extensions.md:1112-1140`）。

**`extensions/40-goal.ts`**
- turn_end 的 notify 文案区分 auto-renew（"auto-renew n/10"）与旧 autoExtend。
- 不改 `usage_limited` 自愈分支、不改 `shouldBlockTool` 白名单。

### 6.4 测试（先写）

**`tests/goal-autorenew.test.mjs`**（node 原生 strip-types，直接 import core）
1. 默认：createGoal(800k) → `recordTurn(900k)` → status `active`、budget = `max(900k+800k, 1.25*900k)`、`autoRenewals=1`、`crossedBudget=false`。
2. 关闭：`PI_LAMBOY_GOAL_AUTORENEW=0` → `budget_limited`（旧行为）。
3. 次数上限：`PI_LAMBOY_GOAL_AUTORENEW_MAX=2`，连续越界 3 次 → 第 3 次 `budget_limited`。
4. 总上限：`PI_LAMBOY_GOAL_MAX_TOKENS=1_000_000`，`recordTurn(1_100_000)` → `budget_limited`，budget 不变。
5. 非 token 预算（turn/wall-clock）越界不受自动续接影响。
6. `autoExtend=true` 旧路径仍消耗 `topUps` 而非 `autoRenewals`。

**`tests/handoff-goal-renew.test.mjs`**
1. budget_limited goal → `renewForHandoff(append)` → `active`、budget ≥ used+800k、append 收到 `lamboy_goal` entry（含新预算）。
2. `PI_LAMBOY_HANDOFF_GOAL_RENEW=0` → 预算不变、不恢复（仅返回 false）。
3. complete / 无 goal → 无副作用、append 不被调用。
4. 8M 上限：used 已 8.2M → 不扩展，保持 budget_limited。

### 6.5 验证

```bash
cd /Users/liulian.leliy/github-projects/pi-lamboy-harness
npm test           # 全量
npm run typecheck  # tsc
```

实机 smoke（可选）：长任务触发一次自动续接 → 观察通知与 footer；`/handoff` 后新 session 首 turn 无 tool gate 拦截、预算显示扩展后的值。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 自动续接无人值守烧 token | 默认 10 次 + 8M 硬上限；`PI_LAMBOY_GOAL_AUTORENEW=0` 一键回滚 |
| 自动续接与旧 `autoExtend` 重复扩容 | 优先级明确：`autoExtend` 先判定，二者互斥 |
| handoff 写入旧 session | 持久化只走 `setup(sm).appendCustomEntry`，不碰旧 `pi.appendEntry` |
| 计数器回退 | `autoRenewals` 与 `topUps` 一样按单调合并（`restoreFromData`） |
