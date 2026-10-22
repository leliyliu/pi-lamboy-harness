# Goal Token Budget Policy — 大预算策略(500k 下限 / 800k 默认)

- 日期:2026-09-29
- 状态:已实现
- 需求来源:用户明确指令——"当前每次进行 goal 的时候,预算都太少了,我要求预算要给更大,比如给到 500k,甚至 800k,不能这么小";并在方案确认中选定 **默认 800k + 强制抬升 500k 下限**
- 需求落地范围:重新配置到 pi agents(`~/.pi/agent/AGENTS.md` 新增"Goal 预算规范"章节)

## 1. 根因

预算大小**完全由模型在 `create_goal` 时自选**,代码没有任何默认值与数值指引:

- `packages/core/goal/index.ts:71-95` `createGoal()` 原样使用传入的 `budgetLimits`,无兜底
- `packages/core/goal/tools.ts`(旧)"Budget limits for the goal" 描述无任何数值规范 → 模型每次保守给小预算(如 50k/100k),导致 goal 过早 `budget_limited`

## 2. 设计

### 2.1 策略语义(仅工具层,即模型路径)

| 场景 | 行为 |
| --- | --- |
| `create_goal` 未传 `tokenBudget` | 自动填默认 **800000** |
| `create_goal` 传 `tokenBudget < 500000` | 抬升至 **500000**(下限) |
| `create_goal` 传 `tokenBudget ≥ 500000` | 原样保留(模型可自选 500k-800k) |
| `set_goal_budget` unit=tokens 且值 < 500000 | 抬升至 500000(与 create 一致,防止绕过) |
| `set_goal_budget` unit 非 tokens(turns/ms/...) | 不注入默认 tokenBudget,原样生效 |

**不受策略影响的路径**(用户是最高决策者,核心层零改动):
- `goalManager.createGoal()` 核心方法——用户侧 `/goal create`、队列 `enqueue`/runtime 恢复均直调核心,原样保留调用方 limits
- `/goal budget <n> <unit>` 用户命令(`commands.ts`)——用户显式设置直接生效

### 2.2 环境变量(项目 kill-switch 惯例)

| 变量 | 默认 | 语义 |
| --- | --- | --- |
| `PI_LAMBOY_GOAL_TOKEN_BUDGET` | `800000` | 未传 tokenBudget 时的默认值;设 `0` 关闭默认填充 |
| `PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET` | `500000` | 下限;设 `0` 关闭抬升 |

env 在策略函数内运行时读取(非模块加载时),进程内即时可调、可测。

### 2.3 落点

1. `packages/core/goal/budget.ts` — 新增 `enforceTokenBudgetPolicy()`(读取 env + 默认/抬升规则)
2. `packages/core/goal/tools.ts` — create_goal / set_goal_budget execute 接线;参数 description + promptGuidelines 写入策略规范(注入系统提示,模型在工具层直接可见)
3. `~/.pi/agent/AGENTS.md` — 新增"Goal 预算规范(重要)"章节;multiloop 语义第 1 条具体化 500k-800k
4. `tests/goal.test.mjs` — §13 回归:默认填充/下限抬升/env 覆盖(含关闭)/set_goal_budget 抬升/文案一致性/核心路径透传
5. `CHANGELOG.md` + `README.zh-CN.md` Budget 条目同步

## 3. 验证

- `node --run tests/goal.test.mjs` §13 全绿(见 CHANGELOG 条目中的检查数)
- `npm run typecheck` 零错误
- `npm test` 全套件绿
- 生效方式:harness 以本地路径加载(`~/.pi/agent/settings.json` packages source),**重启 pi 会话即生效**,无需重装
