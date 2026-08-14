# Phase 0+1 实现计划：改名立项与减法删除

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 pi-muselinn-harness fork 改名为个人包 pi-lamboy-harness，并删除 7 个被白名单第三方包替代的模块（Swarm、Task/Cron、Webfetch、Skills、Hooks、Plugin、agent-file），净删约 6,900 行。

**架构：** 保持现有 core/adapter 分层不变。删除动作 = 删模块目录 + 删对应测试套件 + 在 index.ts 解除接线 + 解耦保留模块的反向引用（pause/ask/todo/tui/permission）。唯一的代码迁移：spinner 动画从 core/swarm/helpers 搬到 core/tui（TUI 保留但依赖 swarm 的 spinner）。

**技术栈：** TypeScript (strict, es2024) · node --test 风格 .mjs 测试 · typebox · @earendil-works/pi-coding-agent 0.83（devDeps 锁定，0.84 升级属 Phase 2）

**设计依据：** `plans/personal-harness-roadmap.md` v0.2（已批准；§4 处置表 #9–#15 + #17）

**边界声明：** 本计划不处理 Permission 精简、Plan 去 Kimi 耦合、Todo claim/release 吸收（均属 Phase 2，见 roadmap §7.2）。Permission 中 `hookEngine.fire` 的 3 处调用因 Hooks 模块整体删除而必须在本计划内移除（否则 import 报错），但 Permission 的其余逻辑不动。

---

## 文件结构总览

| 动作 | 路径 | 说明 |
|---|---|---|
| 修改 | `package.json` | name/author/description/keywords/version |
| 修改 | `README.md` | 顶部改为个人版说明（最小改写） |
| 修改 | `index.ts` | 逐任务解除被删模块的接线（约 -900 行） |
| 删除 | `state.ts` | swarmEnabled 是唯一内容，随 Swarm 删除 |
| 删除 | `swarm/`、`task/`、`webfetch/`、`plugin/`（adapter 层） | 4 个目录 |
| 删除 | `packages/core/swarm/`、`packages/core/task/`、`packages/core/webfetch/`、`packages/core/skills/`、`packages/core/hooks/`、`packages/core/plugin/`、`packages/core/agent-file/` | 7 个目录 |
| 创建 | `packages/core/tui/spinner.ts` | 从 core/swarm 迁入 SPINNER_STYLES/getSpinnerFrames/FRAME_INTERVAL_MS |
| 修改 | `tui/index.ts`、`pause/commands.ts`、`ask/index.ts`、`todo/index.ts`、`packages/core/permission/index.ts`、`packages/core/tool-policy/index.ts`、`packages/core/completions.ts` | 解除对被删模块的引用 |
| 删除 | 10 个测试文件 + 3 个保留套件内的关联用例 | 见各任务 |
| 修改 | `plans/` 下的 plans/*.md 两个旧计划文件 | 与本仓库无关的前作者计划，删除 |

---

### 任务 1：Phase 0 — 基线验证与仓库改名

**文件：**
- 修改：`package.json`、`README.md`
- 删除：`plans/timeout-output-limit-plan.md`、`plans/progress-estimator-plan.md`（前作者的遗留计划，与个人改造无关）

- [ ] **步骤 1：验证当前基线**

```bash
cd /Users/liulian.leliy/github-projects/pi-lamboy-harness
node --version          # 记录版本（需 ≥22.6）
npm test 2>&1 | tail -5   # 预期：28 套件全绿，输出 "all suites passed"
npm run typecheck 2>&1 | tail -3   # 预期：零错误退出
```

若基线本身有失败：停止并报告，不要在红色基线上开始减法。

- [ ] **步骤 2：修改 package.json 元数据**

用 `git config user.name` 或 `gh api user --jq .login` 获取你的 GitHub 用户名（记为 `$USER`）。修改以下字段：

```json
{
  "name": "pi-lamboy-harness",
  "version": "0.10.0",
  "description": "Personal pi harness — Goal lifecycle, Plan gate, Permission guards, Ask, Todo, Pause, TUI, Truncation. Built for long-running autonomous exploration, focused optimization, large-repo maintenance, and academic writing.",
  "author": "$USER",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/$USER/pi-lamboy-harness.git"
  },
  "keywords": [
    "pi-package", "pi-extension", "pi",
    "goal", "plan", "permission", "todo", "ask",
    "tui", "truncation", "personal-harness"
  ]
}
```

保留 `pi`、`files`、`peerDependencies`、`dependencies`、`devDependencies`、`scripts` 字段不动。删除 keywords 中 swarm/subagent/agent/concurrent/batch/parallel/orchestration/kimi-code/auto-mode/yolo-mode/braille/lifecycle（这些描述被删模块）。`files` 数组中的 `"swarm/"`、`"task/"`、`"webfetch/"`、`"plugin/"` 条目随任务 2-7 逐个删除（本任务先不动，避免 files 与目录存在性不一致——npm pack 在 files 引用不存在目录时会警告但不失败，任务 7 结束后它们都会消失）。

- [ ] **步骤 3：README 顶部替换**

将 README.md 前 30 行（从 `# pi-muselinn-harness` 到 Quick start 之前）整体替换为：

```markdown
# pi-lamboy-harness

**个人专属 Pi 编排底座** — Goal（目标生命周期/预算/队列）· Plan（计划门控）· Permission（危险操作守卫）· Ask（结构化提问）· Todo（阶段任务）· Pause（冻结检查）· TUI · Truncation（大输出溢出）。

Fork 自 [MuseLinn/pi-muselinn-harness](https://github.com/MuseLinn/pi-muselinn-harness) 0.9.22（感谢原作者）。
个人改造路线：`plans/personal-harness-roadmap.md`。
子代理/定时任务/搜索/MCP 由白名单第三方包提供（pi-subagents、pi-web-access、pi-mcp-adapter 等），本包只维护差异化核心。
```

README 其余章节暂不重写（任务 8 会在删减后做一致性修剪）。

- [ ] **步骤 4：删除前作者遗留计划文件**

```bash
rm plans/timeout-output-limit-plan.md plans/progress-estimator-plan.md
```

- [ ] **步骤 5：验证并提交**

```bash
npm test 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -2
git add -A
git commit -m "chore: rename to pi-lamboy-harness (personal fork), refresh metadata"
```

预期：测试与 typecheck 与基线一致（本任务零代码改动）。

---

### 任务 2：删除 Webfetch（最简模块，建立删除节奏）

**文件：**
- 删除：`webfetch/`、`packages/core/webfetch/`、`tests/webfetch.test.mjs`
- 修改：`index.ts`（解除 fetch_url 接线）

- [ ] **步骤 1：定位 index.ts 中的接线**

```bash
grep -n "webfetch\|registerFetchUrl\|fetch_url" index.ts
```

预期命中：`import { registerFetchUrl } from "./webfetch/index";`（约 55 行）与调用点。删除该 import 与调用（调用点在初始化函数内，形如 `registerFetchUrl(pi)`）。

- [ ] **步骤 2：删除模块与测试**

```bash
rm -rf webfetch packages/core/webfetch tests/webfetch.test.mjs
```

- [ ] **步骤 3：验证**

```bash
npm run typecheck 2>&1 | tail -2   # 预期零错误（webfetch 无其他引用方）
npm test 2>&1 | tail -2            # 预期 27 套件全绿
```

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "feat!: remove webfetch module — superseded by pi-web-access"
```

---

### 任务 3：删除 Plugin（声明式 bundle，被 pi 原生 package 取代）

**文件：**
- 删除：`plugin/`、`packages/core/plugin/`、`tests/plugin.test.mjs`
- 修改：`index.ts`

- [ ] **步骤 1：解除 index.ts 接线**

```bash
grep -n "plugin\|Plugin" index.ts | grep -v "^.*// "
```

删除：`import { loadPlugins, injectPluginSessionStart, registerPluginCommand, getPluginSkillFiles } from "./plugin/index";`（约 57 行）及 4 个符号的全部调用点。注意 `getPluginSkillFiles` 可能与 skills 注入逻辑交织——先 grep 再逐点删除，遇到与 `listDiscoverableSkillFiles`（任务 5 的目标）共同参与的代码块时，整块删除。

- [ ] **步骤 2：删除模块与测试**

```bash
rm -rf plugin packages/core/plugin tests/plugin.test.mjs
```

- [ ] **步骤 3：验证**

```bash
npm run typecheck 2>&1 | tail -2   # 预期零错误
npm test 2>&1 | tail -2            # 预期 26 套件全绿
```

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "feat!: remove plugin module — pi native packages supersede it"
```

---

### 任务 4：删除 Hooks（Kimi config.toml 引擎）并解耦 Permission

**文件：**
- 删除：`packages/core/hooks/`、`tests/hooks.test.mjs`
- 修改：`index.ts`、`packages/core/permission/index.ts`

- [ ] **步骤 1：解除 index.ts 接线**

```bash
grep -n "registerHooks\|hookEngine\|hooks/" index.ts
```

删除 `import { registerHooks, hookEngine } from "./packages/core/hooks/index";`（约 50 行）及两个符号的全部调用点。

- [ ] **步骤 2：解耦 permission/index.ts（3 处 hookEngine.fire）**

文件 `packages/core/permission/index.ts` 第 9 行 `import { hookEngine } from '../hooks/index.ts';` 及第 139、143、158 行的三处 `try { void hookEngine.fire(...) } catch { /* hooks fail open */ }` —— 全部删除（整行删除，含 try/catch 块；这是纯通知性转发，删除不改变 permission 判定逻辑）。

- [ ] **步骤 3：删除模块与测试**

```bash
rm -rf packages/core/hooks tests/hooks.test.mjs
```

- [ ] **步骤 4：验证（permission 套件必须全绿）**

```bash
npm run typecheck 2>&1 | tail -2
node tests/permission.test.mjs 2>&1 | tail -3   # 预期 26 断言全过
npm test 2>&1 | tail -2                          # 预期 25 套件全绿
```

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat!: remove hooks engine (kimi config.toml compat) — pi extensions subscribe to pi.events natively"
```

---

### 任务 5：删除 Skills 扫描器与 agent-file，清理 tool-policy 工具表

**文件：**
- 删除：`packages/core/skills/`、`packages/core/agent-file/`、`tests/skills.test.mjs`、`tests/agent-file.test.mjs`
- 修改：`index.ts`、`packages/core/tool-policy/index.ts`、`tests/musepi-config.test.mjs`（视检查结果）

- [ ] **步骤 1：解除 index.ts 接线**

```bash
grep -n "skills\|agentFile\|agent_file\|agent-file\|AgentProfile\|findProjectRoot\|resources_discover" index.ts
```

删除：第 58 行 `import { listDiscoverableSkillFiles } ...`、第 70-71 行 agent-file 两个 import、`agent_file_list`/`agent_file_info` 工具注册块（约 1531-1580 行区间）、以及 skills 的 `resources_discover` 工具/资源注入逻辑。**注意**：`agentLifecycle`（import 于第 73 行）是保留模块，不要误删；它若引用 agent-file 符号则需同步修剪（先 `grep -n "agent-file\|agentFile" packages/core/agent-lifecycle/*.ts` 确认，实测无引用则直接过）。

- [ ] **步骤 2：更新 tool-policy 工具名表**

`packages/core/tool-policy/index.ts` 的 `KNOWN_TOOLS`（第 12-22 行）删除以下条目：`"agent", "agent_swarm", "task_list", "task_output", "task_stop", "cron_create", "cron_delete", "cron_list", "agent_file_list", "agent_file_info"`。保留 `read/grep/glob/write/edit/bash/ask_user_question/todo_list/create_goal/get_goal/set_goal_budget/update_goal/web_search/fetch_content/enter_plan_mode/exit_plan_mode`。

- [ ] **步骤 3：检查 musepi-config.test.mjs 归属**

```bash
head -30 tests/musepi-config.test.mjs
```

该套件测 `packages/core/config` 的 MusePi/Kimi 配置兼容。若其断言对象是被删的 skills/hooks 扫描路径（`.kimi-code/` 等），删除 `tests/musepi-config.test.mjs` 并检查 `packages/core/config/` 是否仅被已删模块引用（`grep -rn "core/config" --include="*.ts" . | grep -v node_modules`）——若无存活引用方则一并删除 `packages/core/config/`；若 permission/profile 等保留模块仍引用则保留目录、仅删测试。执行时以 grep 结果为准并在 commit message 中记录结论。

- [ ] **步骤 4：删除模块与测试**

```bash
rm -rf packages/core/skills packages/core/agent-file tests/skills.test.mjs tests/agent-file.test.mjs
```

- [ ] **步骤 5：验证**

```bash
npm run typecheck 2>&1 | tail -2
node tests/tool-policy.test.mjs 2>&1 | tail -3   # 预期全过（KNOWN_TOOLS 缩减后其用例若引用被删工具名，同步修剪用例）
npm test 2>&1 | tail -2
```

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "feat!: remove skills scanner + agent-file (kimi compat) — pi native skills supersede"
```

---

### 任务 6：删除 Task/Cron，解耦 Ask 后台模式

**文件：**
- 删除：`task/`、`packages/core/task/`、`tests/task.test.mjs`、`tests/cron.test.mjs`
- 修改：`index.ts`、`ask/index.ts`、`tests/ask.test.mjs`、`packages/core/completions.ts`（如引用）

- [ ] **步骤 1：解除 index.ts 接线**

```bash
grep -n "backgroundManager\|registerBackgroundTools\|cronManager\|registerCronTools\|setBackgroundSessionDir\|run_background\|task_list\|task_output\|task_stop\|cron_" index.ts
```

删除第 48-49 行两个 import、第 62 行 `setBackgroundSessionDir`、工具注册调用、以及 631 行附近 `cron_create/cron_delete` 的权限策略分支。

- [ ] **步骤 2：解耦 ask/index.ts 后台提问模式**

`ask/index.ts` 第 40 行 `import { backgroundManager } from "../task/index";` 与第 136-143 行起的 background 注册逻辑（`backgroundQuestionTaskId`/`backgroundStartText`/`background: true` 参数路径）。处理方式：**删除后台模式路径**，`ask_user_question` 工具仅保留前台同步对话框。同步检查工具参数 schema 中的 `background` 字段并删除；`tests/ask.test.mjs` 中引用 `backgroundManager`/后台断言的用例删除（先 `grep -n "background" tests/ask.test.mjs` 定位）。保留套件内其余 ~100+ 断言不动。

- [ ] **步骤 3：删除模块与测试**

```bash
rm -rf task packages/core/task tests/task.test.mjs tests/cron.test.mjs
```

- [ ] **步骤 4：验证**

```bash
npm run typecheck 2>&1 | tail -2
node tests/ask.test.mjs 2>&1 | tail -3    # 预期修剪后全绿
npm test 2>&1 | tail -2
```

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat!: remove background task + cron modules — superseded by pi-subagents schedule/async; ask drops background mode"
```

---

### 任务 7：删除 Swarm（最大模块），迁移 spinner，解耦 pause/todo/tui

**文件：**
- 删除：`swarm/`、`packages/core/swarm/`、`state.ts`、`tests/resume-guard.test.mjs`、`tests/steering.test.mjs`、`tests/transcript.test.mjs`
- 创建：`packages/core/tui/spinner.ts`
- 修改：`index.ts`、`tui/index.ts`、`pause/commands.ts`、`todo/index.ts`、`tests/tui.test.mjs`、`tests/shimmer.test.mjs`（如引用旧路径）、`tests/pause-gate.test.mjs`（如引用 steer）、`package.json`（files 数组）

- [ ] **步骤 1：创建 packages/core/tui/spinner.ts（迁移，非重写）**

从 `packages/core/swarm/helpers.ts` 原样复制 `SPINNER_STYLES`（34-51 行）、`DEFAULT_SPINNER_STYLE`（45 行）、`getSpinnerFrames`（53-66 行，含 `PI_MUSELINN_SPINNER` 环境变量读取逻辑）三个导出；从 `packages/core/swarm/types.ts` 复制 `FRAME_INTERVAL_MS = 250`（95 行）。文件头注释：

```typescript
// Spinner animation primitives — migrated from core/swarm/helpers (swarm removed 2026-02).
// Pure logic, no host imports.
```

环境变量名 `PI_MUSELINN_SPINNER` 保留原名不改（改名会破坏用户已有配置，属 Phase 2 清理项，在 roadmap 追加即可——不要在本任务顺手改）。

- [ ] **步骤 2：更新 tui/index.ts 与测试的 import**

```bash
grep -rn "swarm/helpers\|swarm/types" tui/ tests/ packages/core/ --include="*.ts" --include="*.mjs" | grep -v "packages/core/swarm"
```

将 `tui/index.ts` 第 23-24 行改为：

```typescript
import { getSpinnerFrames } from "./packages/core/tui/spinner";
import { FRAME_INTERVAL_MS } from "./packages/core/tui/spinner";
```

（合并为一条 import 亦可。）`tests/shimmer.test.mjs`、`tests/tui.test.mjs` 中引用 `core/swarm/helpers` 的 spinner 断言改为新路径。

- [ ] **步骤 3：修剪 pause/commands.ts —— 删除 /steer，保留 /pause**

`pause/commands.ts` 含两个命令注册（第 27 行 `pause`、第 38 行 `steer`）。删除：`steer` 命令注册块整体、第 13-14 行两个 import（`swarmState`/`backgroundManager`、第 17-20 行 `steerableTaskIds` 辅助函数）。保留：`pause` 命令与其对 `agentPauseGate` 的使用。命令文件头注释中提及 steering 的句子同步删除。

- [ ] **步骤 4：修剪 todo/index.ts 子代理高亮**

`todo/index.ts` 第 35 行 import `swarmState` 与第 376-380 行 "Wire default subagent descriptions provider" 块整体删除。若 `rt`/widget 提供了 `setDefaultSubagentDescriptions` 的空默认实现，保留空实现（避免改动 widget 渲染路径），仅断开 swarm 数据源。

- [ ] **步骤 5：解除 index.ts 接线（本计划最大一处删减）**

```bash
grep -n "swarm\|Swarm\|agent_swarm\|state.ts\|shared" index.ts | head -40
```

删除：第 25-42 行 swarm types import 块、第 39-42 行 swarm adapter 四个 import、第 63 行 `import shared from "./state"`、`agent_swarm`（779 行起）与 `agent`（1257 行起）两个工具注册块、`registerCommands`（swarm 命令族）调用、`SwarmWidgetComponent` 装配、`/tasks` `/cancel` `/resume` `/swarm-status` 命令注册、以及 `shared.swarmEnabled` 的所有判断分支（swarm 开关逻辑随模块消失，相关分支直接按"已启用"路径折叠或整块删除——以删除后语义等价为准：原 `if (!shared.swarmEnabled) return ...` 的守卫整体删除）。**保留**：goalManager、planManager、permissionManager、ask、todo、tui、pause、truncation 的全部接线。

- [ ] **步骤 6：删除模块与测试**

```bash
rm -rf swarm packages/core/swarm state.ts tests/resume-guard.test.mjs tests/steering.test.mjs tests/transcript.test.mjs
```

`tests/tui.test.mjs` 中引用 swarm/task（task browser、braille grid、estimator）的用例块删除（先 `grep -n "swarm\|braille\|task" tests/tui.test.mjs` 定位）；`tests/tui-box.test.mjs` 中 spinner 断言若引用旧路径改路径，若测 swarm 专属样式则删用例。

- [ ] **步骤 7：更新 package.json files 数组**

删除 `"swarm/"`、`"task/"`、`"webfetch/"`、`"plugin/"`、`"state.ts"` 五个条目（此时对应目录均已不存在）。

- [ ] **步骤 8：验证（三重）**

```bash
npm run typecheck 2>&1 | tail -2       # 预期零错误
npm test 2>&1 | tail -3                # 预期剩余套件全绿
grep -rn "from.*core/swarm\|from.*\./swarm\|from.*state\"\|backgroundManager\|hookEngine" --include="*.ts" index.ts tui/ pause/ ask/ todo/ packages/core/ | grep -v node_modules
# 预期：零命中（残留引用清零）
```

- [ ] **步骤 9：Commit**

```bash
git add -A
git commit -m "feat!: remove swarm module (3.2k loc) — superseded by pi-subagents; migrate spinner to core/tui"
```

---

### 任务 8：Kimi 痕迹清扫 + README 修剪 + 最终验证

**文件：**
- 修改：`index.ts`（残留注释）、`README.md`、`CHANGELOG.md`（追加条目）
- 检查：`tests/agent-lifecycle.test.mjs`、`tests/stream-rules.test.mjs`、`tests/approval-rpc.test.mjs`

- [ ] **步骤 1：Kimi 痕迹扫描（仅限 Phase 1 范围）**

```bash
grep -rn "kimi\|Kimi\|KIMI" --include="*.ts" index.ts tui/ pause/ ask/ todo/ packages/core/goal packages/core/plan packages/core/permission packages/core/ask packages/core/todo packages/core/pause packages/core/tui packages/core/truncation packages/core/tool-policy packages/core/completions.ts packages/core/profile packages/core/agent-lifecycle 2>/dev/null | grep -v node_modules
```

处理规则：**注释/命名中的 Kimi 字样**（如 "kimi-code parity"）→ 改写为中性描述或直接删注释；**运行时 Kimi 路径逻辑**（`.kimi-code/` 目录、`$KIMI_CODE_HOME`）若出现在保留模块（预期集中在 permission 的 AGENTS.md 层级与 profile）→ **不要删**，那是 Phase 2 的 #5 精简工作，在 commit message 中列出位置清单留给 Phase 2。

- [ ] **步骤 2：三个待定测试套件归属检查**

```bash
node tests/agent-lifecycle.test.mjs && node tests/stream-rules.test.mjs && node tests/approval-rpc.test.mjs
```

若因任务 5-7 的删除而已被修剪过则直接过；若有失败用例，按"用例测的是被删模块行为 → 删用例；测的是保留模块 → 修用例"处理。`stream-rules` 与 `truncation` 是保留的输出治理模块，其套件必须全绿保留。

- [ ] **步骤 3：README 一致性修剪**

删除 README 中以下已失效章节：Swarm、Task (background + cron)、Web fetch、Plugins、Skills、Hooks（Features 大节中的对应小节）、Commands 表中 `/swarm` `/tasks` `/cancel` `/resume` `/steer` `/plugins` `/swarm-status` 行、Tools 表中 `agent_swarm`/`agent`/`run_background`/`task_*`/`cron_*`/`fetch_url` 行、"Kimi Code alignment" 整节、Architecture 图中已删目录。保留 Goal/Plan/Permission/Ask/Todo/Pause/TUI/Truncation 章节。

- [ ] **步骤 4：CHANGELOG 追加**

`CHANGELOG.md` 顶部新增：

```markdown
## 0.10.0 (2026-02-XX)

Personal fork of pi-muselinn-harness 0.9.22. Breaking reduction per plans/personal-harness-roadmap.md:

- Removed: Swarm, Task/Cron, Webfetch, Skills scanner, Hooks engine, Plugin bundles, agent-file (superseded by pi-subagents / pi-web-access / pi native skills+packages)
- Removed: Kimi Code compat layer shipped with those modules
- Migrated: spinner primitives from core/swarm to core/tui
- Kept: Goal, Plan, Permission guards, Ask (foreground), Todo, Pause, TUI, Truncation
```

- [ ] **步骤 5：最终三重验证 + 本地加载验证**

```bash
npm test 2>&1 | tail -3            # 全绿，记录最终套件数
npm run typecheck 2>&1 | tail -2   # 零错误
grep -rn "kimi-code\|KIMI_CODE_HOME" --include="*.ts" . 2>/dev/null | grep -v node_modules | wc -l   # 记录残留数（预期仅剩 permission/profile 内 Phase 2 待清点）
```

本地加载验证（在仓库目录外启动）：

```bash
cd /tmp && pi -e /Users/liulian.leliy/github-projects/pi-lamboy-harness --print-system <<<'reply ok' 2>&1 | head -20
```

预期：扩展加载无 duplicate tool / import 错误。（若该命令形态在当前 pi 版本不适用，改用 `pi -e <path>` 交互启动后 `/reload` 肉眼确认无报错。）

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "docs: prune README/CHANGELOG to post-reduction reality; sweep kimi references (phase-1 scope)"
```

---

## 自检记录

- **规格覆盖度：** roadmap §4 清单 #9–#15（七个删除项）→ 任务 2-7 一一对应；#17 改名 → 任务 1+8；Kimi 痕迹（Phase 1 范围）→ 任务 8；`pi -e` 加载验收（roadmap Phase 1 验收标准）→ 任务 8 步骤 5。Phase 2 的 #1-#8 精简项不在本计划，边界已在开头声明。
- **占位符扫描：** 无"待定/TODO/后续实现"；三处"执行时以 grep 结果为准"的分支决策（musepi-config 归属、tui.test 用例修剪、agent-lifecycle 引用检查）均给出了判定规则与两条分支的具体动作，非占位符。
- **类型一致性：** spinner 迁移的三个导出名（`SPINNER_STYLES`/`getSpinnerFrames`/`FRAME_INTERVAL_MS`）与 tui/index.ts 现有 import（23-24 行实测）名字一致；`KNOWN_TOOLS` 缩减清单与 tool-policy/index.ts:12-22 实测内容一致。
