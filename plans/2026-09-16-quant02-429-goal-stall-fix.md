# quant02 429 goal 卡死事故调查与修复（2026-09-16）

## 用户问题

> 我在本地已经优化了 429 导致的 goal 阻塞问题，但我现在 quant02 上还存在这个问题……你需要检查是当前还存在这个问题，还是 quant02 上没有进行合理的更新，并为我修复该问题。

## 调查结论（一句话版）

**quant02 已完全同步本地修复（`9f58ba2`），"没更新"不成立**；残余问题是一个 `9f58ba2` 未覆盖的**另一个 bug**——usage_limited 注入文案误导 + 无运行时自愈——本地代码同样存在，只是没在现场暴露。已双修复并部署两端。

## 证据链

### 1. quant02 环境与本地完全一致（"没更新"不成立）

| 检查项 | 本地 Mac | quant02 | 结论 |
|---|---|---|---|
| repo HEAD | `549c2e5` | `549c2e5`（同步前） | 一致 |
| 工作树 | 干净 | 干净 | 一致 |
| pi 版本 | 0.85.1 | 0.85.1 | 一致 |
| node | v26.4.0 | v22.23.2 | 均 ≥22.18，native strip-types |
| settings.json packages | 同 12 项扩展白名单 | 同 12 项 | 一致（均指向各自 repo 源码路径） |

- 同步通道既有：remote `quant02` = `ssh://quant02/home/liulian/github-projects/pi-lamboy-harness`，`receive.denyCurrentBranch=updateInstead`（push 即更新工作树）
- `9f58ba2 fix(goal): allow update_goal to self-recover from usage_limited`（update_goal 的 `case "active"` 路由补上 usage_limited→resume）在同步前的 quant02 HEAD 中**已存在**

### 2. 事故现场回放（quant02 session `2026-09-16T02-40-50-415Z`，jdcloud GLM-5.3）

```
04:24:48  429 x3  {"cause":"tokens limit for minute","code":429,"status":"RATE_LIMIT"}
          → turn_end 检测正确，goal 标记 usage_limited ✅（9f58ba2 之前的检测路径正常）
04:25:21  wrap-up 注入生效，模型输出暂停小结 ✅
06:02–06:07  限流窗早已恢复（模型每轮都成功生成），但：
  - 用户 5 次「继续执行」→ 模型每轮重新输出暂停小结，拒绝调用任何工具 ❌
  - 06:05:06 get_goal 成功执行（证明工具放行本身没问题——shouldBlockTool 是死代码，
    没有任何 tool_call 接线，"工具被阻塞"本来就是谎言）
  - 06:06:06 用户把 update_goal(status="active") 原样贴给模型
    → thinking："The user is telling me the provider quota is still exhausted
       and tool calls are blocked. I need to provide a brief wrap-up without
       tool calls." → 仍然拒绝 ❌
```

### 3. 根因

旧 `buildWrapUpInjection()`（usage_limited 分支）两句话各自致命：

1. **"Tool calls are blocked while the rate-limit window is active"** —— 模型（GLM-5.3）解读为*包括 update_goal 在内的一切工具被阻塞*。五轮 thinking 原文均引述该句。
2. **"Once the provider quota window clears, you may call update_goal(...)"** —— 限流窗恢复**没有事件通知模型**，"窗口是否已过"在模型内部不可观测 → 它永远在等一个不会来的信号，把用户的恢复指令也解读成"配额仍未恢复"。

`9f58ba2` 修的是 update_goal 工具层的路由（模型**调用**时不再 no-op），但模型在提示层就**根本不会去调用**——所以现场依旧卡死。

## 修复（commit `785b91e`，本地 + quant02 双端）

### ① 注入文案改为"恢复教学"（`packages/core/goal/index.ts`）

新文案的核心是一个**可观测的恢复判据**：

> "The rate-limit window has ALREADY cleared: **you are generating this very response**, and an active 429 would have failed the generation itself."

（活跃的 429 会令生成本身失败 ⇒ 模型能读到这段话就证明窗口已过——逻辑上封死了"等信号"的歧义。）随后给出指令：立即 `update_goal(status="active")`（明示该工具与 get_goal 始终可用）→ 继续干活；禁止 create_goal、不再要求 wrap-up 小结（小结请求正是六轮复读的驱动器）。budget_limited 分支保持用户决策语义不变。

### ② turn_end 运行时自愈（`extensions/40-goal.ts`）

不依赖模型自觉的兜底：健康 assistant turn（`stopReason !== "error"`）意味着 provider 恢复服务 → 自动 `resume("runtime")` + 通知。即使模型完全无视新文案，最迟在第一个健康 turn 结束时 goal 已恢复 active。budget_limited 不自愈（tokensUsed 单调，自愈=立即再超限烧 token，保留用户决策）。

### ③ 顺带修正

- `extensions/40-goal.ts` 目录导入 `../packages/core/goal` → 显式 `../packages/core/goal/index.ts`（与 82-sanitize/85-handoff/96-solpi 同模式；native node 可加载、jiti 兼容——这是入口测试可写的前提）
- `tools.ts` update_goal 的 status 参数描述同步改为"after a provider 429 you are still able to generate responses, which means the window has cleared: call it immediately"

### TDD 过程

先写失败测试（红：4 处文案断言 FAIL + 入口测试因目录导入 `ERR_UNSUPPORTED_DIR_IMPORT` 无法加载），后实现（绿）。

## 验证

| 验证项 | 本地 Mac | quant02 |
|---|---|---|
| `tests/goal-429-recovery.test.mjs`（新，真实入口 + stub pi，R1–R4：session 恢复 / 注入文案 / 429 检测不回归 / turn_end 自愈 / budget_limited 不自愈，10 检查） | 10/10 | 10/10 |
| `tests/goal.test.mjs`（新增 §11 文案、§12 shouldBlockTool 允许名单，48 检查） | 48/48 | 48/48 |
| 全量套件 `node tests/run-all.mjs` | all suites passed | all suites passed |
| `tsc -p tsconfig.json` | 零错误 | —（同代码） |
| `pi -p "/goal"` headless 冒烟 | — | EXIT=0，无扩展加载错误 |
| 部署 | `git push origin main`（549c2e5..785b91e） | `git push quant02 main`（updateInstead 自动更新工作树，HEAD=785b91e，干净） |

注：真实 429 无法按需复现（需烧穿 jdcloud 分钟配额），端到端验证以"真实扩展入口 + stub pi 驱动完整事件流（session_start 恢复→context 注入→turn_end 自愈）"的行为锁定测试代替——覆盖的正是事故链路的每一环。

## 后续（可选加固，未做）

- `shouldBlockTool` 至今仍是死代码（无 tool_call 接线）。当前无实际危害（自愈后窗口内 stray 工具调用也能跑，本地工具不耗 provider 配额），若未来要做"usage_limited 期间硬阻塞非 goal 工具"，注意与 30-permission 的询问顺序（permission 先问用户、goal 后拒）会有一次多余对话框。
