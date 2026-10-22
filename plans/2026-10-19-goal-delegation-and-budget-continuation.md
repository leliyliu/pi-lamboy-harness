# Spec：Goal 高效委派（subagents）与预算耗尽自动续接（handoff）

> 日期：2026-10-19 · 状态：**待 review** · 目标读者：仓库所有者
> 关联背景：`plans/2026-09-29-goal-token-budget-policy.md`（预算策略）、`plans/2026-09-16-quant02-429-goal-stall-fix.md`（usage_limited 自愈）
> 状态保持：**usage_limited（429 自愈）路径完全不动**——本 spec 只改 budget_limited 与委派两条线。

---

## 0. TL;DR

用户报告两个问题：

1. **Goal 下很少用 subagents 加速**：goal 执行中模型几乎不委派，全是父会话内联干活。
2. **Goal budget 频繁不够用，且耗尽后难以 handoff**：一旦 budget_limited，模型被注入文案禁止用工具（含 handoff 工具），用户既不能顺畅续跑（resume 立即再超限），也不能顺畅交接（handoff 草稿没提前落盘）。

修复方案分两个方向、七项改动：

- **方向 A（委派加速）**：A1 goal 注入委派指引 + A2 委派 token 记账感知 + A3 预算预警档位注入
- **方向 B（预算续接）**：B1 耗尽 turn 强制先写 handoff 草稿 + B2 tool_call 硬拦截白名单（接线闲置的 shouldBlockTool）+ B3 `/goal resume` 自动 top-up + B4 可选 autoExtend

---

## 1. 根因分析（证据链）

### 1.1 为什么 goal 下不委派

| # | 事实 | 证据 |
|---|---|---|
| 1 | `subagent` 工具描述写死「只有操作者明确要求才委派，任务大小/复杂度/风险本身不构成授权」，且 declaration 被 pinned，harness 无法追加描述 | pi-subagents `src/extension/index.js:11-37,61` + `declaration-pinning.js:40`（scout 实测） |
| 2 | 用户级 `~/.pi/agent/AGENTS.md`「日常委派策略」已有总授权（分层规则表），但 goal 注入文案**完全没有引用或强化**它 | `~/.pi/agent/AGENTS.md:75-96`；对比 `packages/core/goal/index.ts:710-736`（buildInjection 只有 objective + criterion + budget line） |
| 3 | goal 工具 promptGuidelines 无委派指引 | `packages/core/goal/tools.ts:18-27` |
| 4 | goal 记账对委派**无感知**：turn_end 只读 `event.message.usage`，而 subagent child 的 usage 汇总进 `toolResult.usage`，不进父 assistant msg.usage | `extensions/40-goal.ts:138-145`；pi-subagents `subagent-executor.js:2778-2794`（child usage 逐条累加进 tool result）；pi `types.d.ts:828-835`（TurnEndEvent 已含 toolResults） |

结论：模型在 goal 执行中每 turn 看到的是「objective + 预算数字」，而 subagent 工具描述又是保守授权——没有任何一条通道告诉它「这个 goal 下委派是预授权的、而且更省预算」。委派的真实经济性（child 上下文不进父 session，父上下文增长慢）在 goal 体系里完全不可见。

### 1.2 为什么 budget 频繁耗尽

| # | 事实 | 证据 |
|---|---|---|
| 1 | 记账公式 `input + output`：每 turn 的 input 含当轮上下文重发（cacheRead 减轻 API 成本但不减 goal 记账）；复杂任务下 800k 也只够 ~15-30 个富上下文 turn | `extensions/40-goal.ts:142`；pi-ai `types.d.ts:255-273`（input/cacheRead/cacheWrite 分列，goal 只取 input+output） |
| 2 | 父会话内联干活是主要放大器：每轮读文件/命令输出都进父上下文，input 单调膨胀；委派本可把探索内容挡在父 session 之外 | 1.1#4 + 设计逻辑（委派省的是父上下文） |

结论：问题 1 和问题 2 是**同一个病灶的两面**——不委派 → 父上下文膨胀 → 记账的 input 指数增长 → 预算频繁耗尽。

### 1.3 为什么耗尽后难以 handoff / 难以续跑

| # | 事实 | 证据 |
|---|---|---|
| 1 | 耗尽后注入文案：`buildWrapUpInjection` budget_limited 分支要求「You MUST NOT use any tools now ... wait for the user」——**handoff 工具也被压制**，模型无法在耗尽 turn 把交接草稿落盘 | `packages/core/goal/index.ts:489-511` |
| 2 | `shouldBlockTool` 定义了却**从未接线**（只有 plan 模块的 shouldBlockTool 在 20-plan.ts:64 被调用）→ 「不许用工具」实际是软文案，无硬保证 | `packages/core/goal/index.ts:526-538`（定义）；`grep shouldBlockTool` 全仓只有 plan 与 goal 两处，goal 无调用点；接线范式见 `extensions/20-plan.ts:58-66`（`tool_call` 事件 `return { block: true, reason }`） |
| 3 | `/goal resume` 陷阱：resume 只改 status，tokenBudget 不变；下一 turn `recordTurn` 判定 `newTokens >= tokenBudget` 必然成立 → **立即再次 budget_limited**，用户体验是「resume 了跟没 resume 一样」 | `packages/core/goal/commands.ts:37-45` → `index.ts resume()`（只重置 status/wallClock）；`index.ts:340`（crossedTokens 判定）；`tests/goal.test.mjs:283-293`（该设计被测试固化：LLM 自动恢复禁止，留给用户——本 spec 保留此设计意图，只改用户入口的行为） |
| 4 | handoff 的 context guard 只看 context window 用量（90%），与 goal budget 无关——预算耗尽不触发任何 handoff 引导 | `extensions/85-handoff.ts:122-131` |
| 5 | handoff 工具的 agent-authored draft 流程**已经存在且完好**：模型调 handoff 工具 → draft 落 session entry → turn_end 自动 `setEditorText("/handoff")` → 用户一键确认切换 | `extensions/85-handoff.ts:45-75,114-119`；`handoff/commands.ts:56-62`（draft fresh 时跳过重新生成） |

结论：续接的「零件」全都在（handoff draft 流程、tool_call 拦截范式、resume 命令），缺的只是把它们和 budget_limited 状态**接起来**。当前设计把 budget_limited 当成「终点等用户」，但它应该是「自动落盘交接 → 等用户一键续接」。

---

## 2. 方向 A：Goal 高效委派

### A1. goal 注入增加委派指引（核心改动）

**位置**：`packages/core/goal/index.ts` `buildInjection()` active 分支（index.ts:710-736）。

**行为**：active goal 时，在 budget line 之前追加固定委派段（约 80-100 tokens，每 turn 注入）：

```
Delegation (pre-authorized for this goal):
- Explore unfamiliar code / multi-file review / parallel research → delegate to subagents (scout, reviewer) instead of reading everything inline.
- Independent parallel implementation lanes → workflow fan-out (worker lanes), one writer per lane (worktree if concurrent writes).
- Trivial single-file edits and orchestration decisions stay inline.
- Delegated child tokens are billed to this goal's budget (recorded at turn_end); child context stays out of this session, keeping your input growth slow — delegation is the budget-cheapest way to work.
```

- **可关闭**：env `PI_LAMBOY_GOAL_DELEGATION=0` 不注入该段（默认开）。
- **cache 影响**：注入本来就是 ephemeral tail user message（index.ts:791-793 注释的 cache-friendly 设计），追加固定段不增加 cache 失效成本。
- **不依赖 AGENTS.md 存在**：文案自洽（不写「见 AGENTS.md」字样），无该文件的环境同样生效。

**验收**：goal active 时 mock context event，断言注入文本含委派段；env=0 时不含。

### A2. 委派 token 记账感知

**位置**：`extensions/40-goal.ts` turn_end handler（40-goal.ts:136-158）。

**行为**：turn_end 除现有 `msg.usage` 记账外，遍历 `event.toolResults`，把每个 result 的 `usage.totalTokens`（或 `input+output`，与现有公式一致）经 `goalManager.recordTokenUsage(delta)` 记入 goal——**不增加 turnsUsed**（turnBudget 语义保持「父 turn 数」不变）。只统计 `subagent` 工具名的 result（避免普通工具 usage 重复计：普通工具 result 不携带 usage，但做名字过滤更稳）。

- 记账目的：(a) 预算反映 goal 全家真实消耗，续接判定才有意义；(b) 注入文案（A1）告知模型「child tokens 计入预算」，配合委派省父上下文的事实，模型会自然倾向「委派 + 精简编排」。
- async child（detach 进程）完成时父会收到 native wake，其 usage 是否回流 toolResults：scout 证实 async 完成通知不带 usage（上游改进点）——**async child 漏记为已知限制**，文档注明；前台 child/workflow lane 全覆盖。

**验收**：单测 mock turn_end event 带 `toolResults: [{ toolName: "subagent", usage: { input: 1000, output: 500 } }]`，断言 tokensUsed +1500 且 turnsUsed 不变。

### A3. 预算预警档位注入（兼服务于方向 B 的「提前落盘」）

**位置**：`packages/core/goal/budget.ts` `budgetBandGuidance()`（budget.ts:60-66）。

**行为**：在现有数字行（`Budget: ↑X/Y (Z% used)`) 后按档位追加一行：

- **≥ 80%**：`Budget ≥80%: prefer delegation over inline work; if the goal legitimately needs more, ask the user to raise via set_goal_budget.`
- **≥ 95%**：`Budget ≥95%: call the handoff tool NOW with a complete self-contained briefing (context, decisions, files, next task) so the user can continue via /handoff in one keystroke. Then keep working only if the user raises the budget.`

- 阈值可配置：env `PI_LAMBOY_GOAL_BUDGET_WARN=80` / `PI_LAMBOY_GOAL_BUDGET_CRIT=95`（百分比整数，0 关闭对应档）。
- **这是「难以 handoff」的前置防线**：95% 档让模型在还健康的 turn 就把 handoff 草稿写好落盘；即使下一 turn 直接爆掉，draft 已在 session entry 里，用户 `/handoff` 零成本续接。

**验收**：单测分别构造 79/80/94/95% 的 snapshot，断言注入行文案。

### A4. goal 工具 promptGuidelines 补充

**位置**：`packages/core/goal/tools.ts:18-27`（create_goal guidelines）。

**行为**：追加一条 guideline：
`"When a goal is active, proactively split work into subagent delegations (explore → scout, review → reviewer, parallel implementation → worker lanes); this session stays the orchestrator — inline only for trivial edits"`

（静态指引进系统提示，与 A1 的每 turn 注入互补；改动零风险。）

---

## 3. 方向 B：预算耗尽自动续接

### B1. 耗尽 turn 强制先写 handoff 草稿

**位置**：`packages/core/goal/index.ts` `buildWrapUpInjection()` budget_limited 分支（index.ts:489-511）。

**行为**：文案改为（usage_limited 分支不动）：

```
⚠️ Token budget exceeded. Allowed tools right now: get_goal, handoff, update_goal (nothing else).

1. Call the handoff tool NOW with a complete self-contained briefing:
   - context & decisions so far
   - files involved (paths)
   - the goal's objective & completion criterion, remaining work, suggested next budget
   The briefing is the only thing the next session sees.
2. Then give a 2-3 line wrap-up. Do NOT continue goal work inline.

The user continues via /handoff (one keystroke) — the draft you write now is what they get.
```

- 与 85-handoff.ts 现有流程无缝衔接：handoff 工具落 `HANDOFF_DRAFT_TYPE` entry → turn_end `setEditorText("/handoff")`（85-handoff.ts:114-119）→ 用户确认切换（draft fresh 时跳过重新生成，commands.ts:56-62）。
- 超预算成本：写 briefing 约 1-2k tokens，超出 budget 一点——**接受**（换来的是交接零损失）；A3 的 95% 档已在多数情况下把草稿前置到健康 turn。
- briefing 中要求带上 goal objective/criterion/建议预算 → 新 session 可直接 `create_goal` 续跑（B5）。

**验收**：单测断言 budget_limited 注入文案含 `handoff` 指令与白名单；`tests/goal-429-recovery.test.mjs`（usage_limited 路径）保持通过。

### B2. shouldBlockTool 接线（软文案 → 硬保证）

**位置**：`extensions/40-goal.ts` 新增 `pi.on("tool_call", ...)` handler；`packages/core/goal/index.ts:526-538` shouldBlockTool 白名单扩为 `[get_goal, update_goal, handoff]`。

**行为**：
- goal status ∈ {budget_limited, usage_limited} 时，block 白名单之外的一切工具，`return { block: true, reason: "Goal budget_limited: only get_goal/handoff/update_goal allowed. Write the handoff briefing." }`。
- 接线范式照抄 20-plan.ts:58-66（同一事件返回 `{block:true, reason}`）。
- 加载顺序说明：40-goal 在 30-permission 之后，permission 弹窗可能先行出现；但 budget_limited 下注入已约束模型不乱调工具，即便调用也会被 deny——功能正确，spec 注明此顺序即可（不为它改文件名）。
- 环境开关：`PI_LAMBOY_GOAL_TOOL_GATE=0` 关闭（默认开）。

**验收**：单测直接测 shouldBlockTool 矩阵（状态 × 工具名）；接线层用 mock pi 的 on("tool_call") 断言 block 返回值。

### B3. `/goal resume` 自动 top-up（修 resume 陷阱）

**位置**：`packages/core/goal/commands.ts` resume 分支（commands.ts:37-45）+ `index.ts` 新增 `resumeWithTopUp()`。

**行为**：用户跑 `/goal resume` 且当前状态 budget_limited 且 `tokensUsed >= tokenBudget` 时：

1. 自动 raise：`newBudget = max(tokensUsed + 500_000, ceil(tokensUsed * 1.25 / 50_000) * 50_000)`（至少再给 500k、或留 25% 空间，50k 对齐；两项策略取大者）。
2. 然后 resume → active。
3. notify：`Budget auto-topped-up: 800k → 1.3M. Adjust with /goal budget <n> tokens. (auto top-up #1 of 3)`

- **设计意图保留**：LLM 的 `update_goal(status="active")` 对 budget_limited **仍然 no-op**（tests/goal.test.mjs:283-293 的语义不变）——自动续期权只属于用户入口（`/goal resume`）与显式 `set_goal_budget`。
- **次数上限**：snapshot 新增 `topUps?: number` 字段（持久化经现有 goalToEntryData），默认上限 3 次，超过后 resume 退回现状（提示用户显式 `/goal budget <n> tokens`）。上限可配：`PI_LAMBOY_GOAL_TOPUP_MAX=3`（0 = 不限）。
- 只对 tokenBudget 触发；turnBudget/wallClock 的超限语义不变（turn 停了就是停了，resume 即续，无陷阱）。

**验收**：单测覆盖：超限 resume → budget 自动抬升 + status active；未超限 resume（paused）行为不变；topUps 计数持久化与上限拒绝；update_goal(active) 仍然不触发。

### B4. 可选：耗尽自动续期（autoExtend）——默认关

**位置**：`packages/core/goal/tools.ts` create_goal 参数 + `index.ts` recordTurn。

**行为**：create_goal 新增 `autoExtend?: boolean`（默认 false）。开启时 recordTurn 的 crossedTokens 分支不进 budget_limited，而是自动 `tokenBudget += 500k`（步长可配 `PI_LAMBOY_GOAL_EXTEND_STEP`）、notify、继续 active；同样受 topUps 上限保护，达到上限退化为现状。

- **决策点**：默认值交给用户 review 拍板（见 §6-D1）。我的建议：**默认关**。理由：budget_limited→handoff draft 落盘（B1+B2）+ resume top-up（B3）已经把「耗尽后难以续接」修平；autoExtend 会让预算失去制动意义，与 2026-09-29 政策「budget_limited 留给用户决策」精神冲突。但若用户更在意「goal 永不中断」，可改默认开。

### B5. handoff 草稿要求携带 goal 状态

**位置**：B1/A3 文案中已包含（briefing 须含 objective/criterion/剩余工作/建议预算）——纯文案改动，无代码。新 session 的模型据此一键 `create_goal`，新 goal 从零记账（合理：新会话新预算）。

---

## 4. 改动清单（文件级）

| 文件 | 改动 | 对应 |
|---|---|---|
| `packages/core/goal/index.ts` | buildInjection 委派段；buildWrapUpInjection 重写 budget_limited 分支；shouldBlockTool 白名单 +handoff；resumeWithTopUp()；snapshot 增 topUps 字段 | A1, B1, B2, B3 |
| `packages/core/goal/budget.ts` | budgetBandGuidance 档位文案（80/95%） | A3 |
| `packages/core/goal/types.ts` | GoalSnapshot 增 `topUps?: number`；persistence.ts 序列化透传 | B3 |
| `packages/core/goal/commands.ts` | /goal resume 接 resumeWithTopUp；notify 文案 | B3 |
| `packages/core/goal/tools.ts` | create_goal guidelines 追加委派条目；（若 D1 选开）autoExtend 参数 | A4, B4 |
| `extensions/40-goal.ts` | turn_end 读 toolResults[].usage 记账；新增 tool_call gate handler；env 开关 | A2, B2 |
| `packages/core/goal/persistence.ts` | goalToEntryData/goalFromEntryData 透传 topUps | B3 |

改动全部落在 goal 模块与 40-goal.ts，不触碰 pi-subagents、85-handoff.ts、permission 链。

---

## 5. 测试计划（TDD）

1. **先写测试**（`tests/goal.test.mjs` 扩展，纯 node 级，无模型配额）：
   - 注入委派段：active 含、env=0 不含、paused/blocked 不含
   - 档位注入：79/80/94/95% 四点文案
   - wrap-up：budget_limited 分支含 handoff 指令 + 白名单；usage_limited 分支逐字节不变（回归）
   - shouldBlockTool 矩阵：budget_limited × {get_goal, update_goal, handoff, read, bash} ；active × 任意 = false
   - top-up：超限 resume 抬预算并 active；paused resume 不动预算；topUps 计数/持久化/上限；update_goal(active) no-op 回归
   - toolResults 记账：subagent result usage 记入、turnsUsed 不变
2. **回归**：`tests/goal-429-recovery.test.mjs`、`tests/handoff.test.mjs`、`npm run typecheck`、`npm test` 全绿。
3. **实机 smoke**（实施后，需用户配合一次）：env `PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET=0` + `create_goal(tokenBudget=30000)` 跑一个读多文件的小任务，观察：80% 档警告注入、95% 档模型主动调 handoff、耗尽 turn 白名单拦截、`/handoff` 一键切换、`/goal resume` 自动 top-up。

---

## 6. 待 review 决策点

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | B4 autoExtend 默认值 | (a) 默认关，goal 参数可开 (b) 默认开 | **(a)**——与 budget_limited「用户决策」政策一致；B1-B3 已解决续接痛点 |
| D2 | A2 委派 child tokens 是否计入 goal 预算 | (a) 计入（本 spec） (b) 不计，预算只管父会话 | **(a)**——记账真实才有续接判定意义；且委派省父上下文，总账反而更省 |
| D3 | B3 top-up 步长策略 | (a) +500k 或 25% 取大 (b) 固定 +800k (c) 原预算 ×1.5 | **(a)**——渐进、可预期、50k 对齐 |
| D4 | A1 委派段文案长度 | (a) ~100 tokens 四条（本 spec） (b) 压缩到 2 条 ~50 tokens | **(a)**——每 turn 注入成本可接受，四条覆盖 scout/reviewer/worker/边界 |
| D5 | B2 硬拦截是否默认开 | (a) 默认开（env 可关） (b) 只靠注入软约束 | **(a)**——工具封锁从「请求模型自律」变「机制保证」，且白名单含 handoff 不影响 B1 |

---

## 7. 风险与开放问题

1. **async child 漏记**（A2 已知限制）：pi-subagents async 完成通知不带 usage；前台 child/workflow 全覆盖。后续可向上游提 issue。
2. **fork-context child 内 goalManager 状态**：scout 指出 fork 复制的 session entries 可能让 child 内恢复出同一 goal（child-session.js:460-467 推断，未实测）。child 内不写 goal 的话无副作用；实施后加一条实机验证（child 里 get_goal 应不干扰父）。若证实有干扰，属 pi-subagents fork 机制问题，单独立项。
3. **GLM-5.3 对新注入的服从性**：quant02 事故（2026-09-16）表明注入措辞敏感。B1 的白名单式指令（「Allowed tools right now: ...」）复用了 usage_limited 自愈修复中验证有效的句式（明确、可执行、无歧义条件），预期良好；实机 smoke 第 3 步验证。
4. **注入 token 成本**：A1 固定段 + A3 档位行合计每 turn 增加 ~120-150 tokens（ephemeral tail，不影响 cache 前缀）；相对 goal 每 turn 数千-数万 tokens 的消耗，噪声级。

---

## 8. 实施顺序（确认后）

1. A3 + B1 + B2（文案与档位 + 拦截接线）——先修「难以 handoff」
2. B3（resume top-up）——修「难以续跑」
3. A1 + A4 + A2（委派指引 + 记账感知）——修「不委派」
4. 每步先写测试再实现，全量回归后进入下一步；实机 smoke 收尾。

---

*Review 关注点：§6 五个决策点的选择；§2-§3 各项行为的验收标准是否足够。确认后按 §8 顺序实施。*
