# Goal 模式与 multiloop / subagents 并行探索的兼容性分析与补齐方案

> 日期：2026-09-08
> 问题：使用当前 goal 模式做优化探索时，能否使用 multiloop 和 subagents 策略？能否实现多个优化探索并行实现并调优？
> 结论先行：**subagents ✅ 完全兼容（本次已实测验证）；multiloop ❌ 当前环境不可用（未安装 + 与 harness goal 工具名冲突是致命错误）；并行优化探索可用「goal + subagents 多 lane」立即可用补齐，multiloop 补齐需小改动（方案 B1）。**

---

## 1. 当前环境事实（证据）

### 1.1 启用面

`~/.pi/agent/settings.json` packages 数组实测：

| 包 | 状态 | 与 goal 的关系 |
|---|---|---|
| pi-lamboy-harness（8 入口：pause/plan/permission/**goal**/ask/todo/tui/truncation） | ✅ 启用 | goal 模式本体（`extensions/40-goal.ts`） |
| pi-subagents | ✅ 启用 | 工具零冲突，可共存 |
| **pi-multiloop** | ❌ **未安装**（`~/.pi/agent/npm/node_modules/` 无此包；全盘 find 无痕迹） | 见 §2.2 冲突分析 |
| perf-lab（`extensions/90-perf.ts`） | ❌ 被 object-form 过滤（extensions 列表无此项） | 优化场景的测量侧缺席 |

### 1.2 关键机制验证（pi 0.85.1 实测）

| # | 结论 | 验证方式 |
|---|---|---|
| V1 | **工具名冲突 = 致命启动错误**（exit 1），不是降级 | 临时造两个同名 `conflict_test_tool` 扩展，`pi -p -ne -e a -e b` → `Error: Failed to load extension "ext-b": Tool "conflict_test_tool" conflicts with ext-a`，EXIT 1。与 README「已知硬规则 1」记录一致 |
| V2 | **命令名冲突不是致命错误**（后加载的注册失败或被忽略，进程正常启动） | 同法造两个 `/goal` 命令，`pi -p` 正常启动 EXIT 0 |
| V3 | **goal 激活期间并行 subagent 探索成功** | 见 §2.1 功能级实测 |

---

## 2. 逐项回答

### 2.1 subagents：✅ 可以用，且已实测

**代码级证据**：
- harness goal 注册的工具：`create_goal` / `get_goal` / `update_goal` / `set_goal_budget`（`packages/core/goal/tools.ts:18,84,107`）
- pi-subagents 注册的工具：`subagent` / `bg_wait` / `subagent_supervisor`
- 零交集 → 无冲突；两扩展事件模型也不重叠（goal 挂 `turn_end`/`session_start`/`context`；subagents 自建 runs/lanes 体系）

**功能级实测（V3，本会话 2026-09-08）**：
1. `create_goal`（objective=验证兼容性，completion_criterion=两个并行子代理均成功返回，turnBudget=10）
2. 一次 `subagent(workflowScript: runs.all([{scout: 只读探索 goal 状态机}, {scout: 只读探索 core 分层}]))` 并行调用
3. 两个 lane 均 `status=completed`，各自产出摘要文件（explore-goal.md 1.7KB / explore-subagents.md 777B），workflow 返回 `[true, true]`
4. goal 预算计数器全程正常：running 43s → turns 4/10 → tokens 69k → `update_goal(complete, verified=true)` 成功 → 终态 `complete — Budget exceeded`（token 超 50k 上限，状态机转换正确）

**一个需要注意的 gap（已验证的行为，非推测）**：
goal 的 `recordTurn` 只从**父会话** `turn_end` 的 `msg.usage` 记账（`extensions/40-goal.ts:118-127`）。子代理是独立 `AgentSession`（`pi-subagents/src/runs/shared/child-session.ts:16-19`），其内部多轮探索消耗**不计入** goal 预算；只有子代理结果作为工具结果回流父上下文时才以 input token 形式入账。→ 并行探索时，**每 lane 的预算控制要靠 subagent 参数自身的 `usageBudget`（tokens/costUsd）**，goal 预算只约束父会话编排层。

### 2.2 multiloop：❌ 当前不可用，且直接安装必然失败

**冲突对**：harness `get_goal` / `update_goal` ↔ pi-multiloop quick-goal 的同名工具（`pi-multiloop/extensions/pi-multiloop/index.ts:1806,1827`，npm 0.4.0 tarball 实测源码）。

**为什么无法用 object-form 过滤规避**：
- pi-multiloop 的 manifest 是 `"pi": {"extensions": ["./extensions"]}` —— **单入口目录**，goal.ts 的 quick-goal 工具与 9 个 `multiloop_*` 工具全部在同一个 `index.ts` 里注册
- object-form 过滤只能挑选入口文件路径，无法只加载其中一部分工具 → 要么全量（与 harness goal 撞名 → V1 致命错误），要么不装
- minimal.v0.1.json 的 `$comment` 明确记录了这个决策：「NOT included: pi-multiloop (get_goal/update_goal tool-name conflict with harness Goal — fatal load error, verified 2026-09-06)」

**替代语义是否可接受**：pi-multiloop 的 `/goal`（quick goal，无 metric）与 harness 的 `/goal`（目标生命周期/预算/队列）语义重叠度高——你已经有更完整的 goal 了。真正缺的是它的 **measured loop**（`multiloop_start/iterate/measure` 的 edit→measure→keep/revert + MAD 置信度 + `.multiloop/` JSONL 持久史）。

### 2.3 「多个优化探索并行实现并调优」的现状

| 能力 | 现状 | 证据 |
|---|---|---|
| 并行探索（多方案同时试） | ✅ **立即可用**：goal + `subagent(workflowScript: runs.all/runs.lanes)` | V3 实测 |
| 并行写入隔离 | ✅ **立即可用**：`worktree: true`（每个子代理独立 git worktree）或 `runs.lanes` 有界并行链 | subagent 工具描述 + pi-subagents SKILL |
| 测量/显著性 | ⚠️ **需加回 perf-lab**：`bench_run`/`profile_parse`/`metric_compare`（Mann-Whitney improve/regress/noise 判决）在仓库里但被过滤 | settings.json extensions 列表无 `90-perf.ts` |
| keep/revert 自动循环 | ❌ 无（multiloop 的核心；可用路径 B1 解锁或手动编排） | — |
| 每 lane 预算 | ✅ subagent `usageBudget`；⚠️ goal 预算不穿透子代理（见 2.1 gap） | 2.1 验证 |

---

## 3. 补齐方案

### 方案 A（推荐 · 零改动 · 已验证）：goal + subagents 并行探索

```
/goal <优化目标> + set_goal_budget          # 父会话：目标/预算/完成判据
subagent(workflowScript: runs.lanes([...]))  # 并行 lane：每 lane 一个探索方向
  ├─ lane 1 (scout/worker, worktree)  → 方案 1 实现 + 自验
  ├─ lane 2 (worker, worktree)        → 方案 2 实现 + 自验
  └─ lane 3 ...                        → N 路并行
汇总 → metric_compare 逐对显著性检验 → 择优合并
```

启用步骤（1 步）：把 `extensions/90-perf.ts` 加回 settings.json 的 harness extensions 数组（重启 pi）。多 lane 的实现隔离用 `worktree: true`；调优裁决用 `metric_compare`（Mann-Whitney + MAD，与 multiloop 的置信度方法同源）。

局限：keep/revert 由你在 workflowScript 里自己写（`git checkout`/`git restore`），没有 multiloop 的状态持久史（`.multiloop/` JSONL）。

### 方案 B1（小改动 · 解锁 multiloop）：harness goal 工具改名开关

给 `packages/core/goal/` 加一个开关（如 settings 或 `PI_LAMBOY_GOAL_ALIAS` 环境变量）：开启时 `get_goal`/`update_goal` 改名为 `lamboy_get_goal`/`lamboy_update_goal`（`create_goal`/`set_goal_budget` 不冲突，保留原名），`/goal` 命令照常。之后 `pi install npm:pi-multiloop` 即可共存——quick-goal 的 `/goal` 归 multiloop，生命周期/预算/队列归 harness（改名后）。

- 改动量估计：`tools.ts` 两处 name + 开关读取 + 测试用例（~50 行）
- 代价：文档/肌肉记忆里 `get_goal` 语义分裂为两套（harness 面板 vs multiloop quick goal）
- 这是 audit 文档遗留项 N3（harness Goal ↔ multiloop lane 适配器）的最小实现

### 方案 C（不推荐）：切 preset 关掉 harness goal 换 multiloop

`presets/` 加一个含 multiloop、不含 `40-goal.ts` 的预设。代价：失去 goal 的队列/三重预算/持久恢复/完成判据门控——这些正是 harness 的差异化核心，得不偿失。

---

## 4. 建议

1. **现在就用方案 A**：本次实测已证明 goal + 并行 subagents 无冲突；探索类并行（读代码、多方案调研、A/B 实现）直接可用
2. 若近期有「测量驱动的 keep/revert 循环」刚需（如 kernel 调优），排期做 **B1**（一个下午的改动 + 测试）
3. 每次动 settings.json 前跑 `node presets/switch.mjs diff <preset>` 核对工具面（catalog.md 已知规则 1/2 的教训）

## 4.2 multiloop 语义保障：守卫 + 指令双层落地（2026-09-09）

**背景**：用户在 quant02 终端手动 `pi install npm:pi-multiloop`（11:27 npm 包落地，11:28 settings.json 写入，mtime 实证）→ pi fatal 启动失败（get_goal/update_goal 双冲突，stderr 实证）。已修复：settings.json 剔除该条目（备份 `settings.json.bak-broken-multiloop-20260909`），`pi -p` 恢复 EXIT 0。

**双层防护**：

| 层 | 实现 | 验证 |
|---|---|---|
| 硬守卫（permission） | 新 policy `known-tool-conflict-install-deny`（id 42，安全层，先于 auto/yolo approve）：deny `pi install … pi-multiloop`（bash）与 settings.json 引入该包（write/edit）；deny reason 引导模型改用方案 A | TDD 7 用例（27/27），quant02 同样 7/7；实弹：headless 会话被拦，settings.json md5 前后一致 |
| 指令层（AGENTS.md） | quant02 + 本地 `~/.pi/agent/AGENTS.md` 追加「优化探索策略（multiloop 语义）」节：multiloop = 方案 A 工具链（非 npm 包），严禁安装 + 被拒后不重试 | 自然语言实测：问「CUDA 算子 multiloop 优化探索」→ 模型直接给出方案 A 完整工作流（goal/bench_run/runs.lanes/worktree/metric_compare/verified=true），不提议安装 |

代码：`packages/core/permission/policies.ts`（policy04cKnownConflictInstallDeny）+ `tests/permission.test.mjs` §7；同 commit 修复 8b74bcb 遗留的 3 处 TS2353（timestamp 字段未声明）。

## 4.1 方案 A 落地记录（2026-09-09，本地 + quant02 双端安装）

| 端 | 动作 | 验证 |
|---|---|---|
| 本地（macOS, pi 0.85.1） | `~/.pi/agent/settings.json` 备份后原子加回 `extensions/90-perf.ts`（80-truncation 之后） | `pi -p` 启动 EXIT 0；工具面实测含 `bench_run/profile_parse/metric_compare` + goal 4 工具 + `subagent/bg_wait`（TOTAL=29）；备份 `settings.json.bak-20260909-092046` |
| quant02（Ubuntu 22.04, H20 GPU 机, pi 0.85.1, node v22.23.2/nvm） | 同样脚本（scp 过去）备份 + 原子加回 | ssh 隧道（127.0.0.1:22213）执行；`pi -p` 启动 EXIT 0；工具面同上（TOTAL=29，唯一差异 `web_search_pi` 是 pi-web-access 版本差异，与本次无关） |

- 预设同步：新增 `presets/minimal.v0.2.json`（harness 9/10 模块，latex 仍过滤）+ `catalog.md` 登记；`switch.mjs diff minimal.v0.2` 对本地当前面零差异
- **分叉已合并（2026-09-09，merge commit `00eeb02`）**：本地 `cf0b54e`（presets v0.2）与 quant02 `8b74bcb`（feat(cache)：动态注入从 system prompt 迁至尾部 user message，前缀缓存友好，90.2% prefill 节省）零冲突合入；合并后全量测试 22 套件 / 596 断言通过（含新 `tests/cache-stability.test.mjs`）；已推送 origin（GitHub）；quant02 同步到同一提交。文件面不相交（presets/docs vs core 注入代码），后续双端同步可用 `git fetch quant02 && git merge quant02/main`
- quant02 回滚：`cp ~/.pi/agent/settings.json.bak-<ts> ~/.pi/agent/settings.json` 后重启 pi

## 5. 证据附录

- 工具冲突致命性复现：`/tmp/pi-conflict-test/`（两个同名工具扩展，pi 0.85.1，EXIT 1）
- 并行探索实测：workflow run `e9bf50c9-fa49-4d7f-9f1c-e09fc94c9c97`，子代理产物 `~/.pi/agent/sessions/.../subagent-artifacts/outputs/e9bf50c9-*/explore-{goal,subagents}.md`
- pi-multiloop 源码核对：npm 0.4.0 tarball（`/tmp/ml-inspect/package/`），quick-goal 工具注册于 `extensions/pi-multiloop/index.ts:1806-1855`
- harness goal 工具注册：`packages/core/goal/tools.ts:18,84,107`
- goal 记账位置：`extensions/40-goal.ts:118-127`（turn_end → msg.usage）
- 子代理 session 独立性：`pi-subagents/src/runs/shared/child-session.ts:1-19`
