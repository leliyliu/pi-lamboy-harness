# 2026-10-28 预算自动加钱 / 少 handoff / handoff 后自动续跑

> 用户反馈（2026-10-28）：「遇到预算不足应该自动加预算，并且减少 /handoff，此外 handoff 之后还需要优化，这个逻辑目前用起来还是没优化。」
> 澄清结果：Q1 **两种都遇到**（有时卡在 budget_limited 不自动续，有时续了但模型 95% 就停手催 handoff）；Q2 只要求收敛**「95% 档不再催 handoff」**；Q3 handoff 之后的问题是**「新会话不会自动接着干，要我催」**。

## 1. 现状与证据

### 1.1 代码证据（两套策略互相打架）

| 文件:行 | 现状 | 问题 |
|---|---|---|
| `packages/core/goal/budget.ts:118` | `≥95%` 注入 `call the handoff tool NOW … Then keep working only if the user raises the budget` | 模型在还有 5% 时就停手写交接稿 → 直接被催 handoff |
| `packages/core/goal/budget.ts:121` | `≥80%` 注入 `ask the user to raise via set_goal_budget` | 提额推给用户，与原意「自动加预算」相反 |
| `packages/core/goal/index.ts:814-826` | budget_limited wrap-up 第 1 条 `Call the handoff tool NOW`，并要求 `Do NOT continue goal work inline` | 耗尽即 handoff，runtime 的续接能力完全没用上 |
| `extensions/40-goal.ts:32-49` | 工具门拦截 reason 里也写 `Write the handoff briefing … /handoff` | 同一个 handoff-first 预设 |
| `packages/core/goal/index.ts:392-405, 490-505` | auto-renew **只在 `newTokens >= tokenBudget` 的那一 turn** 触发 | 是撞墙补救；跨进程/跨会话恢复出来的 `budget_limited` 没有任何再入点 |
| `handoff/commands.ts:145-171` | `withSession` 只 `setEditorText(编辑后的 briefing)` | 新会话停在编辑器，必须用户手动回车 → 「要我催」 |

### 1.2 真实会话数据证据（`~/.pi/agent/sessions` 的 `lamboy_goal` 条目）

- `g-mvpcho72-7amv`（2026-10-27，多轮优化 goal）：`800k → 1,649,746 → 2,487,489`，在 **used=2,326,708 / bud=2,487,489（93.5%）时预算被人工抬到 3,000,000**，之后又自动续 2 次到 5,350,000，最终 complete @4,944,711（renew=4）。
  - 说明：auto-renew 本身**有效**（确实跨限续了 4 次），但**93.5% 附近仍然需要用户出面**——因为 80% 档文案让模型停下来问用户。
- `g-mvovhm7h-k14g`（2026-10-27 01:32）：`active → budget_limited @used=2,045,473 / bud=1,819,266`，靠 `/goal resume`（topUps 3）恢复。
  - 说明：确实存在「没有自动续、卡在 budget_limited」的实例（跨会话恢复的 budget_limited 无再入点）。
- 2026-10-26 21:35 之前的 issue 全部有 `topUps`（手动 resume），10-26 之后突然出现的人工提额点正好落在 93.5%（80% 档文案作用区），与文案假设一致。

## 2. 目标

1. **预算不足自动加**：在 80% 附近就自动扩预算（提前量），跨限兜底续接，且**恢复出来的 `budget_limited` 也能自动复活**——用户不需要 `/goal resume`、不需要 `set_goal_budget`。
2. **95% 不再催 handoff**：预算档位文案改成「继续干，runtime 会加钱」；budget_limited 只有在**总预算硬上限 / 关闭自动续期**时才出现，且文案不再指挥 handoff。
3. **handoff 之后自动续跑**：新会话直接以编辑后的 briefing 作为首条 user message 自动提交，模型立刻接着干（保留 `PI_LAMBOY_HANDOFF_AUTOSUBMIT=0` 回退为「只预填编辑器」）。

非目标：上下文 guard（90%）不动；`/handoff` 的用户入口语义不动；turn/wall-clock 预算耗尽不走自动续（跨会话累计，续了也立刻再超）。

## 3. 设计

### C1 提前量自动扩预算（proactive headroom）

`packages/core/goal/index.ts`：

- 新增 `private headroomPct(): number`（`PI_LAMBOY_GOAL_TOPUP_AT`，默认 **80**，0/100 关闭）。
- 新增 `private maybeExtendHeadroom(used: number): { budget: number; count: number } | undefined`
  - 条件：`tokenBudget > 0` 且 `used >= tokenBudget * headroomPct / 100` 且 `canAutoRenew(autoRenewals)` 且 `autoRenewBudget(used)` 有值且 `> tokenBudget`。
  - 动作：`tokenBudget = autoRenewBudget(used)`（公式与跨限一致：`max(used+800k, ceil(used×1.25/50k)×50k)`，受 8M 总量上限约束），`autoRenewals += 1`。
- `recordTurn()` / `recordTokenUsage()`：在跨限判定**之前**先跑 `maybeExtendHeadroom(newTokens)`；
  - 扩了 → 本 turn 不再触发跨限（预算已高于 used）；
  - 返回值新增 `autoRenewed.reason: "headroom" | "crossing"`，UI 文案区分「提前补足余量」/「跨限自动续接」。
- 语义不变的部分：`autoExtend`（旧 B4 路径）优先且互斥；`PI_LAMBOY_GOAL_AUTORENEW=0` 完全回到旧行为。

### C2 `budget_limited` 自动复活（re-entry）

`packages/core/goal/index.ts` 新增 public：

```ts
autoRecoverBudget(): { renewed: true; newBudget: number; count: number } | null
```

- 前置：`status ∈ {active, budget_limited}`、`tokenBudget > 0`、无 turn/wall-clock 越界、`canAutoRenew`、`autoRenewBudget(used) > tokenBudget`。
- 动作：扩预算；`budget_limited → active`（清 `terminalReason`、置 `wallClockResumedAt`）；`persist()`。
- 调用点：
  1. `extensions/40-goal.ts` 的 `context` 事件处理里、`injectIntoMessages` 之前（每次模型请求都会跑）——覆盖**跨进程/跨会话恢复出来的 budget_limited**；
  2. `session_start` 恢复之后（早一点让徽标正确）；
  3. 与 C1 共用同一套 env 与上限，避免两条扩预算路线互相绕过。

### C3 budget_limited wrap-up 去 handoff 化

`buildBudgetLimitedWrapUp()` 重写为「硬上限/关闭自动续期才出现」的收尾：

- 第 1 条改成：说明这是**总预算上限或自动续期关闭**造成的停止，`handoff` 不会增加预算（预算是 goal 级、跟着会话走）；
- 指示：给 2-3 行收尾（已完成 / 剩余 / 需要的预算），让用户决定 `set_goal_budget` 或 `/goal resume`；
- **删除** `Call the handoff tool NOW`、`Do NOT continue goal work inline`、`/handoff 一键续接` 三处 handoff 指令；
- 白名单 `GOAL_LIMITED_ALLOWED_TOOLS` 保留 `handoff`（不禁止，只是不再指挥），工具门 reason 同步改写。

### C4 预算档位文案（95% 不再催 handoff）

`packages/core/goal/budget.ts:budgetTierLine()`：

- `≥80%`：`keep working; the runtime tops the token budget up automatically before exhaustion — do not stop, do not ask the user to raise it, do not hand off for budget reasons; keep preferring delegation.`
- `≥95%`：`keep working; the automatic top-up fires at this level or at the crossing. Do NOT call the handoff tool or write a briefing for budget reasons — handoff is for context exhaustion only.`
- `PI_LAMBOY_GOAL_BUDGET_WARN` / `_CRIT` 语义保留（0 关闭对应行）。

### C5 handoff 之后自动续跑

`handoff/commands.ts:reviewAndSwitch()`：

- `withSession` 里：
  - 默认（`PI_LAMBOY_HANDOFF_AUTOSUBMIT !== "0"`）：`replacementCtx.sendUserMessage(edited)` —— briefing 直接作为新会话首条 user message 提交，模型立刻继续；
  - `=0`：退回当前行为（`setEditorText(edited)`，用户手动回车）；
- 通知文案区分两种模式（`Handoff ready — continuing automatically.` / 旧文案）。

### C6 文档与测试

- `README.md:71`、`README.zh-CN.md:61`、`CHANGELOG.md`：预算档位语义更新（80% 自动补余量、95% 继续干、耗尽只在硬上限出现、handoff 后自动续跑）+ 新 env 表。
- `packages/core/goal/tools.ts:60-70`（`autoExtend` 描述里「exhausted turn is gated to write a handoff briefing」）同步改写。
- 测试：
  - `tests/goal.test.mjs` §14/§15/§16 文案与语义断言按新文案重写（新增：「95% 档不含 handoff 指令」「wrap-up 不含 Call the handoff tool NOW」「reason 不含 handoff 指令」）。
  - `tests/goal-autorenew.test.mjs` 新增：80% 提前扩预算（79/80 边界）、`reason="headroom"`、`PI_LAMBOY_GOAL_TOPUP_AT=0` 关闭、硬上限下不提前扩。
  - `tests/handoff-goal-renew.test.mjs` 或新 suite：`autoRecoverBudget()` 从 `budget_limited` 复活、turn/wall 越界不复活、上限打满不复活。
  - `tests/handoff.test.mjs` 扩展：`reviewAndSwitch` 自动提交（stub ctx 断言 `sendUserMessage` 被调用、`setEditorText` 未被调用；`PI_LAMBOY_HANDOFF_AUTOSUBMIT=0` 时相反）。

## 4. 验收（必须跑出证据）

1. `npm test` 全绿（含新增用例）。
2. `npm run typecheck` 零错误。
3. 纯核心单测即可验证 C1/C2/C3/C4：构造 79/80/94/95% snapshot 断言文案；构造 budget_limited snapshot 断言 `autoRecoverBudget` 复活与跨限续接的一致性。
4. 人造端到端（不需模型配额）：用 `restoreFromData` 造 `budget_limited` + `tokensUsed > tokenBudget`，走 40-goal `context` handler → 断言 goal 变 `active` 且注入里**不含** `handoff tool NOW`。
5. 实机验证（需用户配合，我会给出步骤）：`PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET=0` + `create_goal(tokenBudget=300000)` 跑一个小任务，观察：80% 自动加钱通知、95% 不再出现催 handoff 的注入、耗尽 turn 若发生也不催 handoff；`/handoff` 后新会话自动开始第一轮。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 提前扩预算让 token 消耗更快失控 | 仍受 `PI_LAMBOY_GOAL_AUTORENEW_MAX`(10) 与 `PI_LAMBOY_GOAL_MAX_TOKENS`(8M) 双重上限；`PI_LAMBOY_GOAL_TOPUP_AT=0` 只关闭 C1 提前量（撞限续接 + C2 自动复活仍在），真正的总开关是 `PI_LAMBOY_GOAL_AUTORENEW=0`（C1/C2 同时失效） |
| `context` 里改 goal 状态引起递归/抖动 | `autoRecoverBudget` 幂等（预算已高于 used 就 no-op），恢复后注入不再含 wrap-up，事件不会自激 |
| 自动提交 briefing 抢走用户对首条消息的控制 | `PI_LAMBOY_HANDOFF_AUTOSUBMIT=0` 回退；用户已在 `editor` 里审阅/编辑过 briefing |
| 旧测试固化「95% 催 handoff」语义 | 按新语义重写 §14/§15/§16，CHANGELOG 记录行为变更 |

---

## 6. 实施记录（2026-10-28）

| 变更 | 落地位置 | 关键点 |
|---|---|---|
| C1 提前量扩预算 | `packages/core/goal/index.ts` → `topUpAtPct()` / `headroomTopUp()`，接入 `recordTurn`（跨限判定之前）与 `recordTokenUsage` | `PI_LAMBOY_GOAL_TOPUP_AT` 默认 80；共用 `autoRenewMax` / `PI_LAMBOY_GOAL_MAX_TOKENS`；`autoExtend` goal 与 turn/wall-clock 同时越界时跳过；返回 `autoRenewed.reason="headroom"` |
| C2 自动复活 | `autoRecoverBudget()`；`extensions/40-goal.ts` 的 `session_start` + `context`；`packages/core/goal/tools.ts` 的 `update_goal(active)` | token-only、幂等；turn/wall 越界或触顶返回 null；预算已覆盖用量时只 resume 不扩 |
| C3 wrap-up | `buildBudgetLimitedWrapUp()` | 删除 3 处 handoff 指令；改为「说明 handoff 不加预算 → 2-3 行汇报 → set_goal_budget 解封 → 预算覆盖后自动 resume」 |
| C4 档位 | `packages/core/goal/budget.ts:budgetTierLine()` | 80%：继续干 + 自动加预算 + 优先委派；95%：继续干、不要为预算 handoff；env 语义不变 |
| C5 自动续跑 | `packages/core/handoff/switch.ts`（新）+ `handoff/commands.ts` | 审阅后的 briefing 经 `sendUserMessage` 成为新会话首条消息；失败回落 `setEditorText`；`PI_LAMBOY_HANDOFF_AUTOSUBMIT=0` 回退 |
| 文档 | `README.md` / `README.zh-CN.md` / `CHANGELOG.md` / `tools.ts` 描述 | 档位语义、耗尽续接、handoff 续跑、新 env 全部同步 |

**测试**：`npm test` 全绿（goal 135 / goal-autorenew 49 / handoff 55 / handoff-autosubmit 10 新增；全套 `all suites passed`），`npx tsc -p tsconfig.json` 零错误。
新增用例覆盖：79%/80% 分界、`reason` 标记、`TOPUP_AT=0`、8M 触顶后不再扩、turn 双越界不预扩、`autoRecoverBudget` 复活/不复活矩阵（turn 越界、超总上限、关闭开关、已覆盖用量、active 未超限）、自动提交 / env 回退 / 发送失败回落。

**reviewer 复核（2026-10-28）与修复**：
- **Finding 1（P0，已修）**：`headroomTopUp` 原按 `used` 定步长（`used+800k`），而触发阈值是新预算的 80%，迭代收敛到不动点 `b=0.8b+800k=4M` —— 10 次续接在 `used≈3.66M` 烧完，比改动前（8M）**提前 54% 停**，末段还几乎每轮一次 notify。修复：按 `max(budget, used)` 定步长（`index.ts:headroomTopUp`），序列回到 `800k→1.6M→2.4M→3.2M→4M→5M→6.25M→7.8125M→8M`（8 次），并用「反复 recordTurn 直到停」的循环测试钉住 8M 上限与 ≤10 次。
- **Finding 2（P2，已修）**：`autoRecoverBudget` 原来直接重置 `wallClockResumedAt`，会丢掉在途 active 区间；现先把 `liveWallClockMs(g)` 折入 `wallClockMs`（对 budget_limited 是 no-op），并加 5s 在途区间的回归用例。
- **Finding 3（P2，已修）**：补 `recordTokenUsage` 提前量用例、`restoreFromData(budget_limited)` 走真实 `context` handler 的接线用例（`tests/goal-wiring.test.mjs`）、`update_goal(active)` 自愈用例（§17h2，1.7M）；并把两个「vacuous pass」旧用例改为真断言（§10b 无预算可扩 → no-op；§17h 改为 AUTORENEW=0 下的 no-op）。
- 另修正 stale 注释（`index.ts:shouldBlockTool` 白名单理由、`types.ts` GOAL_LIMITED_ALLOWED_TOOLS 注释）与本文档 §5 回滚说明。

**待实机验收（需用户配合，约 2 分钟）**：
1. `PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET=0` 启动，`create_goal(tokenBudget≈300000)` 跑一个读多文件的小任务；
2. 观察 80% 档起是否出现「Goal budget topped up ahead of exhaustion to … (auto-renew #N)」通知，且注入里**不再**出现 `handoff tool NOW`；
3. 若 goal 被恢复成 `budget_limited`（重启 pi 后再 `get_goal`），确认首轮自动回到 active 并续预算；
4. `/handoff` 后确认新会话**自动开始第一轮**（无需回车/催）。
