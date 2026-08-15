# Phase 2 实现计划：守卫层化、死代码清扫与命名统一

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 roadmap Phase 2——Permission 守卫层化（删 Kimi 层级与死代码）、六个死模块清扫、muselinn→lamboy 命名统一（26 处）、Todo 吸收 claim/release 多会话语义、升级 pi 0.84.2、文档对齐、排除 pi-agent-extensions 完成补位迁移。

**架构：** 延续 core/adapter 分层。Permission 保留 policyChain 架构（服务 plan/goal 的策略不动），只删 Kimi 指令层级与死代码路径。Todo 在 core/todo/types.ts 的 TodoOperation 模型上扩展 claim/release 操作与 TodoItem 元数据字段，adapter 层透出。命名统一是纯机械替换（用户零历史负担，已确认）。

**技术栈：** TypeScript (strict, es2024) · node 测试 · typebox · @earendil-works/pi-coding-agent 0.83→0.84.2

**设计依据：** `plans/personal-harness-roadmap.md` §7.2 Phase 2 + 终审登记的 Phase 2 清单 + 2026-08-14 四项用户决策（守卫层化 / 删 Kimi 留标准 AGENTS.md / 删 agent-lifecycle / muselinn 立即全改）

**已确认的决策记录（问询 2026-08-14）：**
1. Permission：守卫层化——保留 policyChain 架构与服务保留模块的策略，删 Kimi 层级+死代码
2. AGENTS.md：删 `.kimi-code/` 与 `$KIMI_CODE_HOME` 两处死路径；保留项目裸 AGENTS.md + `~/.agents/AGENTS.md` 跨工具层
3. agent-lifecycle：删除（模块+测试；不做事件桥）
4. muselinn 命名：立即全改（PI_LAMBOY_* / lamboy-tui.json / lamboy_goal 等；用户无历史配置与 entry，零迁移负担）

**边界声明：** Plan"去 Kimi 耦合"经侦察已在 Phase 1 注释清扫中消解（plan/index.ts 无 kimi 字样、无 Kimi 分支代码），本计划只做验证不再动 plan 逻辑。Permission 的 /mode 命令与 auto/yolo/manual 模式语义保留（这是本包自有模式，非 Kimi 遗留）。

---

## 文件结构总览

| 动作 | 路径 | 说明 |
|---|---|---|
| 删除 | `packages/core/agent-lifecycle/`、`tests/agent-lifecycle.test.mjs` | 决策 3 |
| 删除 | `packages/core/profile/` | 零生产引用（终审确认） |
| 删除 | `packages/renderer/`、`tests/renderer.test.mjs` | test-only 死模块 |
| 删除 | `packages/core/config/`、`tests/musepi-config.test.mjs` | 生产零引用（"4 个测试引用"为文件名误报，实测仅 musepi-config 一个） |
| 删除 | `packages/core/tool-policy/`、`tests/tool-policy.test.mjs` | 唯一生产消费点 permission:108 isActive 恒真，随调用点一并删（裁定：清扫自然延伸） |
| 修改 | `packages/core/permission/` | 删 evaluateForSubagent、删 isActive 调用、config.ts 删 Kimi 路径、注释清理 |
| 修改 | `index.ts`、`tui/`、`todo/`、`packages/core/{tui,plan,completions,todo,ports,goal}/` | muselinn→lamboy 机械替换（26 处/10 文件） |
| 修改 | `packages/core/todo/types.ts`、`todo/index.ts` | claim/release 操作 + claimedBy/claimedAt 字段（TDD） |
| 修改 | `package.json` | devDeps 0.84.2、version 0.11.0、files 数组更新 |
| 修改 | `README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`.npmignore`、roadmap | 文档对齐 + 日期统一修正（2026-02-11→2026-08-14） |

---

### 任务 1：死代码清扫 A——删除三个纯死模块

**文件：**
- 删除：`packages/core/agent-lifecycle/`（76 行）、`tests/agent-lifecycle.test.mjs`
- 删除：`packages/core/profile/`（269 行）
- 删除：`packages/renderer/`（276 行）、`tests/renderer.test.mjs`
- 修改：`index.ts`、`tsconfig.json`、`package.json`（若有引用则解除）

- [ ] **步骤 1：确认零引用**

```bash
cd /Users/liulian.leliy/github-projects/pi-lamboy-harness/.worktrees/phase0-1-reduction
grep -rn "agent-lifecycle\|core/profile\|packages/renderer" --include="*.ts" --include="*.mjs" --include="*.json" index.ts package.json tsconfig.json packages/ ask/ todo/ tui/ pause/ tests/ 2>/dev/null | grep -v "packages/core/agent-lifecycle/\|packages/core/profile/\|packages/renderer/\|tests/agent-lifecycle\|tests/renderer"
```

预期：零命中（agent-lifecycle 接线已在 Phase 1 终审删除；profile 的唯一 importer swarm 已删；renderer 从未被生产引用）。若有命中，先解除引用再删目录。

- [ ] **步骤 2：删除**

```bash
rm -rf packages/core/agent-lifecycle packages/core/profile packages/renderer tests/agent-lifecycle.test.mjs tests/renderer.test.mjs
```

- [ ] **步骤 3：验证**

```bash
npm run typecheck 2>&1 | tail -2   # 零错误
npm test 2>&1 | tail -2            # 16 套件全绿
grep -rn "agent-lifecycle\|core/profile\|packages/renderer" --include="*.ts" --include="*.mjs" . 2>/dev/null | grep -v node_modules | grep -v plans/ | wc -l   # 0
```

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "feat!: remove dead modules — agent-lifecycle (per decision), profile, renderer (zero production refs)"
```

---

### 任务 2：死代码清扫 B——删 core/config、tool-policy，Permission 去死代码

**文件：**
- 删除：`packages/core/config/`（95 行）、`tests/musepi-config.test.mjs`
- 删除：`packages/core/tool-policy/`（212 行）、`tests/tool-policy.test.mjs`
- 修改：`packages/core/permission/index.ts`（删 isActive 调用、删 evaluateForSubagent）、`tests/permission.test.mjs`（修剪相关断言）

- [ ] **步骤 1：删 core/config（先验证）**

```bash
grep -rn "core/config\|mergeMusepi\|MUSEPI" --include="*.ts" --include="*.mjs" index.ts packages/ ask/ todo/ tui/ pause/ tests/ 2>/dev/null | grep -v "packages/core/config/\|tests/musepi-config"
```

预期零命中（侦察已确认生产零引用、测试仅 musepi-config）。删除：

```bash
rm -rf packages/core/config tests/musepi-config.test.mjs
```

- [ ] **步骤 2：删 tool-policy 并解除 permission 调用点**

`packages/core/permission/index.ts:108` 附近：

```typescript
if (!toolPolicyService.isActive(toolName)) {
```

该 if 块整体删除（isActive 在空策略层下恒真——删除后行为等价；这是终审发现 4 的裁定）。同时删除文件头部 `toolPolicyService` 的 import。然后：

```bash
rm -rf packages/core/tool-policy tests/tool-policy.test.mjs
```

- [ ] **步骤 3：删 permission 的 evaluateForSubagent**

`grep -n "evaluateForSubagent" packages/core/permission/index.ts` 定位（终审确认仅测试调用）。删除该导出函数；`grep -n "evaluateForSubagent" tests/permission.test.mjs` 找到引用它的测试块并删除对应断言组（保留其余断言，修剪后在报告中记录删了几个断言）。

- [ ] **步骤 4：验证**

```bash
npm run typecheck 2>&1 | tail -2   # 零错误
node tests/permission.test.mjs 2>&1 | tail -3   # 修剪后全绿
npm test 2>&1 | tail -2            # 14 套件全绿
```

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat!: remove core/config + tool-policy + permission dead paths (evaluateForSubagent, isActive passthrough)"
```

---

### 任务 3：Permission 守卫层化——删 Kimi 指令层级

**文件：**
- 修改：`packages/core/permission/config.ts`、`tests/permission.test.mjs`（若测 Kimi 路径）

- [ ] **步骤 1：改写指令文件发现逻辑**

`packages/core/permission/config.ts` 当前层级（侦察实测：84-121 行）：
1. 项目级：裸 `AGENTS.md` + `.kimi-code/AGENTS.md`（nested，102 行）
2. 全局 Kimi：`$KIMI_CODE_HOME/AGENTS.md`（默认 `~/.kimi-code/`，114-117 行）
3. 跨工具：`~/.agents/AGENTS.md`（121 行）

改为（决策 2）：
1. 项目级：仅裸 `AGENTS.md`（向上遍历找最近，保留）
2. 跨工具全局：`~/.agents/AGENTS.md`（保留）
3. 删除：`nested`（.kimi-code）分支、`kimiHome`/`globalKimi` 分支、`KIMI_CODE_HOME` 环境变量读取

同步更新文件头 JSDoc 注释（84-88 行的层级描述）与 186 行附近的聚合说明注释。`grep -n "kimi\|Kimi\|KIMI" packages/core/permission/config.ts` 确认清零。

- [ ] **步骤 2：检查其余死策略与 #1948 注释**

逐个核对 policyChain 17 项（policies.ts:338-357）的 matcher：`grep -n "toolName ===" packages/core/permission/policies.ts`，对照存活工具清单（read/grep/glob/write/edit/bash/ask_user_question/todo_list/goal 四件套/enter_plan_mode/exit_plan_mode + 第三方 web_search/fetch_content/subagent 等）。若发现 matcher 只匹配已删工具（应无——Phase 1 已清），删除该策略。顺手：`permission/index.ts:66` 附近 `#1948` 裸引用注释改为中性描述（终审搁置项）。

- [ ] **步骤 3：验证**

```bash
npm run typecheck 2>&1 | tail -2
node tests/permission.test.mjs 2>&1 | tail -3   # 全绿（若原测试覆盖 .kimi-code 路径发现，同步修剪该断言组并记录）
npm test 2>&1 | tail -2
grep -rn "kimi\|KIMI" --include="*.ts" packages/core/permission/ | wc -l   # 0（除 MIT 出处注释 box.ts/shell-output.ts 不在此目录）
```

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "feat!: permission guard-layer — drop kimi instruction hierarchy (.kimi-code, KIMI_CODE_HOME), keep AGENTS.md + ~/.agents standard"
```

---

### 任务 4：muselinn→lamboy 命名统一（26 处/10 文件）

**文件：**
- 修改：`index.ts`、`tui/index.ts`、`todo/index.ts`、`packages/core/tui/{spinner,timing,config}.ts`、`packages/core/plan/index.ts`、`packages/core/completions.ts`、`packages/core/todo/types.ts`、`packages/core/ports.ts`、`packages/core/goal/types.ts`
- 修改：测试中引用这些名字的断言（`grep -rln "MUSELINN\|muselinn" tests/`）

- [ ] **步骤 1：建立替换映射（精确取值，逐字使用）**

| 旧 | 新 |
|---|---|
| `PI_MUSELINN_SPINNER` | `PI_LAMBOY_SPINNER` |
| `PI_MUSELINN_HARNESS_TUI_TIMING` | `PI_LAMBOY_TUI_TIMING` |
| `PI_MUSELINN_TODO_CLEAR_DELAY` | `PI_LAMBOY_TODO_CLEAR_DELAY` |
| `muselinn-tui.json` | `lamboy-tui.json` |
| `pi-muselinn-harness`（tmpdir 等功能性引用） | `pi-lamboy-harness` |
| `muselinn_goal` | `lamboy_goal` |
| `muselinn_plan` | `lamboy_plan` |
| `muselinn_permission` | `lamboy_permission` |
| `muselinn_todo` | `lamboy_todo` |
| `muselinn.plugin.json`（若残留） | 删除或改 `lamboy.plugin.json` |

注意：spinner.ts 头注释 "migrated from core/swarm" 中的历史描述保留，但 "PI_MUSELINN_SPINNER" 功能名要改。`grep -rn "MUSELINN\|muselinn" --include="*.ts" --include="*.mjs" --include="*.json" . | grep -v node_modules | grep -v plans/ | grep -v CHANGELOG | grep -v README` 先列出全部出现点，逐文件替换（建议用 sed 或编辑器逐个处理，替换后再 grep 复核清零）。

- [ ] **步骤 2：ports.ts 类型名同步**

`packages/core/ports.ts` 若有 `MuselinnXxx` 类型名，改为 `LamboyXxx`（PascalCase 同理）。goal/plan/permission/todo 的 entry type 字符串常量同步（`GOAL_ENTRY_TYPE = "muselinn_goal"` 等——index.ts:30 与 goal/types.ts:93 重复定义处收敛为单一来源：goal/types.ts 导出，index.ts import 使用，删除本地重复）。

- [ ] **步骤 3：验证**

```bash
npm run typecheck 2>&1 | tail -2   # 零错误
npm test 2>&1 | tail -2            # 全绿
grep -rni "muselinn" --include="*.ts" --include="*.mjs" --include="*.json" . 2>/dev/null | grep -v node_modules | grep -v plans/ | grep -v CHANGELOG | grep -v README.md | grep -v README.zh-CN.md | wc -l   # 0
```

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "feat!: rename muselinn->lamboy (env vars, config file, entry types, tmpdir) — zero migration burden per decision"
```

---

### 任务 5：Todo 吸收 claim/release 多会话语义（TDD）

**文件：**
- 修改：`packages/core/todo/types.ts`（TodoOperation 扩展 + TodoItem 字段 + applyOp 分支）
- 修改：`todo/index.ts`（todo_list 工具 op 透出 + 参数 schema）
- 测试：`tests/todo.test.mjs`

- [ ] **步骤 1：编写失败的测试（RED）**

在 `tests/todo.test.mjs` 追加断言组（沿用该文件既有测试风格——先读文件头部 30 行了解 import 与断言模式）：

```javascript
// === claim/release (multi-session semantics) ===
// claim: 标记任务归属，已被其他会话认领的任务不可再 claim（返回错误进 errors）
// release: 释放认领（仅认领者可释放）；done 隐式释放
```

测试用例至少覆盖：
1. `claim` 一个 pending 任务 → `claimedBy` 置为会话标识、`claimedAt` 为时间戳
2. 对已 claimed（他人）的任务再 `claim` → errors 非空、原 `claimedBy` 不变
3. 同一会话重复 `claim` 自己的任务 → 幂等成功（或 errors 提示已持有——选择幂等成功，测试断言无错误）
4. `release` 他人认领的任务 → errors 非空
5. `release` 自己认领的任务 → `claimedBy/claimedAt` 清空
6. `done` 一个 claimed 任务 → 状态 done 且 `claimedBy` 清空（隐式释放）
7. 会话标识从 op 参数的 `sessionId` 字段读取（无 sessionId 时用 "main"）

运行 `node tests/todo.test.mjs 2>&1 | tail -5`，预期新断言失败（op 未实现）。

- [ ] **步骤 2：实现（GREEN）**

`packages/core/todo/types.ts`：
- `TodoOperation` 联合类型追加 `"claim" | "release"`
- `TodoItem` 追加可选字段 `claimedBy?: string; claimedAt?: number;`
- `TodoOpParams` 追加可选 `sessionId?: string;`（或放入通用参数位——遵循现有参数结构）
- `applyEntry`/`applyOp` 路由中追加 `claimTasks`/`releaseTasks` 处理函数（仿照 `removeTasks` 的签名风格：`(phases, entry, errors) => TodoPhase[]`），实现上述 6 条语义；`done` 路径追加隐式释放

`todo/index.ts`：`todo_list` 工具参数 schema 若对 op 有枚举约束则追加两值；execute 透传 `sessionId`（从工具上下文取 session 标识，若不可得则缺省 "main"）。`/todo` 命令补全（completions.ts 若有 op 枚举）同步。

运行 `node tests/todo.test.mjs` → 全绿。

- [ ] **步骤 3：全量验证**

```bash
npm run typecheck 2>&1 | tail -2
npm test 2>&1 | tail -2
```

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "feat(todo): claim/release multi-session semantics — absorb native todo collaboration model (TDD)"
```

---

### 任务 6：升级 pi 0.84.2

**文件：**
- 修改：`package.json`（devDeps 三包 ^0.84.2 或 >=0.84.2）

- [ ] **步骤 1：升级依赖**

```bash
cd /Users/liulian.leliy/github-projects/pi-lamboy-harness/.worktrees/phase0-1-reduction
npm install --save-dev @earendil-works/pi-coding-agent@0.84.2 @earendil-works/pi-ai@0.84.2 @earendil-works/pi-tui@0.84.2 --no-audit --no-fund
```

（若三包 0.84.2 版本不齐，用各自最新 0.84.x；记录实际版本到报告）

- [ ] **步骤 2：适配与验证**

```bash
npm run typecheck 2>&1 | tail -5   # 零错误；若有 API 变更报错，逐个适配（adapter 层为主）
npm test 2>&1 | tail -3            # 全绿
```

- [ ] **步骤 3：Commit**

```bash
git add -A
git commit -m "chore: upgrade pi devDeps to 0.84.x (runtime baseline 0.84.1+)"
```

---

### 任务 7：文档对齐与版本收尾

**文件：**
- 修改：`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`.npmignore`、`plans/personal-harness-roadmap.md`

- [ ] **步骤 1：README 架构图对齐**

两份 README 的 Architecture 图与实际目录对齐：删除已不存在的目录条目（profile、core/config、agent-lifecycle、tool-policy、renderer、swarm 等），补齐实际存在的（packages/core/tui/spinner 等）。测试套件数对齐当前实际值。Todo 节补 claim/release 一句说明。

- [ ] **步骤 2：CHANGELOG 0.11.0**

```markdown
## 0.11.0 (2026-08-14)

Phase 2 per plans/personal-harness-roadmap.md:

- Removed: agent-lifecycle, profile, renderer, core/config, tool-policy modules (dead code sweep)
- Permission: guard-layer — dropped .kimi-code/KIMI_CODE_HOME instruction hierarchy (AGENTS.md + ~/.agents kept), removed evaluateForSubagent and isActive passthrough
- Renamed: all muselinn identifiers → lamboy (PI_LAMBOY_* env vars, lamboy-tui.json, lamboy_* entry types)
- Added: todo claim/release multi-session semantics
- Upgraded: pi devDeps to 0.84.x
```

（同时把 0.10.0 条目日期从 2026-02-11 修正为 2026-08-14——上一轮笔误）

- [ ] **步骤 3：杂项清理**

- `.npmignore`：删除 `*.d.ts` 后自相矛盾的 `!*.d.ts`（或删整组——files 白名单主导）
- roadmap：决策记录表追加 4 行（2026-08-14 四项决策）；Phase 2 清单中已完成的条目标注 ✅；日期 2026-02-11 统一修正为 2026-08-14
- `tui/editor.ts:74` 注释措辞（"custom-editor.ts:261 parity" 补归属或删，终审搁置项）
- `package.json` version → 0.11.0

- [ ] **步骤 4：验证与提交**

```bash
npm test 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -2
grep -rn "2026-02-11" README.md README.zh-CN.md CHANGELOG.md plans/personal-harness-roadmap.md | wc -l   # 0
git add -A
git commit -m "docs: align docs to phase-2 reality, bump 0.11.0, fix date typos"
```

---

### 任务 8：环境迁移与最终验收（控制者亲自执行，不分派）

- [ ] **步骤 1：排除 pi-agent-extensions**

```bash
pi remove npm:pi-agent-extensions
```

- [ ] **步骤 2：本包安装验证（补位检查）**

```bash
cd /tmp && pi -e /Users/liulian.leliy/github-projects/pi-lamboy-harness/.worktrees/phase0-1-reduction -p --no-session <<<'reply ok' 2>&1 | tail -3
```

预期干净 ok；随后交互启动确认工具面板：ask_user_question（本包 ask/）、todo_list（本包 todo/，含 claim/release）在位，无 pi-agent-extensions 残留工具。

- [ ] **步骤 3：roadmap 勾选 Phase 2 完成 + 账本收尾**

---

## 自检记录

- **规格覆盖度：** roadmap Phase 2 五项 → 任务 3（Permission）、任务 5（Todo claim/release）、任务 8（agent-extensions 排除+补位验证）、任务 6（pi 0.84）、Pause 删 /steer 已在 Phase 1 完成（边界声明）；终审 Phase 2 清单六项 → 任务 1/2（profile、config、tool-policy、renderer、agent-lifecycle）+ 任务 4（muselinn 命名）；Plan 去 Kimi → 边界声明（已消解）；终审次要搁置项 → 任务 3（#1948）、任务 7（editor.ts:74、.npmignore、日期、架构图、GOAL_ENTRY_TYPE 收敛于任务 4 步骤 2）。
- **占位符扫描：** 任务 5 测试用例给出语义级 7 条（实现者需先读既有测试风格再落码——这是遵循既有模式的要求，非占位符）；任务 3 步骤 2 的死策略核对给了明确判定规则与预期结论；无"待定/TODO"。
- **类型一致性：** TodoOperation 扩展值、TodoItem 新字段名、替换映射表 10 行——任务内与跨任务引用一致（任务 4 的 entry type 收敛与任务 5 无交集）。
