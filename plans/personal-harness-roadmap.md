# pi-lamboy-harness 个人专属 Packages 改造路线图

> 版本：v0.3（2026-08-14）· 状态：**Phase 1/2 已执行**
> 基线：pi-muselinn-harness 0.9.22（commit ad969a6）· pi 0.84.1
> 目标读者：仓库所有者（个人维护者）

## 决策记录

| 日期 | 决策 | 状态 |
|---|---|---|
| 2026-08-14 | §4 模块处置总表（含 Swarm 全删 3,252 行） | ✅ 已批准 |
| 2026-08-14 | §5.3 白名单 8 包保留 / 排除 pi-agent-extensions | ✅ 已批准 |
| 2026-08-14 | §6 自建优先级：**perf-lab 先于 latex-toolchain** | ✅ 已批准（Phase 3/4 已对调） |
| 2026-08-14 | 终审裁定：删除 docs 站点+pages.yml；release 脚本改名；agent-lifecycle 删接线留模块 | ✅ 已执行 |
| 2026-08-14 | §4 Permission：**守卫层化**——保留 policyChain 架构与服务保留模块的策略，删 Kimi 层级+死代码 | ✅ 已批准 |
| 2026-08-14 | §4 AGENTS.md：**删 Kimi 留标准**——删 `.kimi-code/` 与 `$KIMI_CODE_HOME`，保留项目裸 AGENTS.md + `~/.agents/` | ✅ 已批准 |
| 2026-08-14 | §6 agent-lifecycle（76 行死代码）：**删除**，不做事件桥 | ✅ 已批准 |
| 2026-08-14 | §4 muselinn 命名：**立即全改**（零历史负担，一次到位） | ✅ 已批准 |
| 2026-08-14 | 终审 B1 裁定：安全守卫（destructive/sensitive/git-control）重排至 auto-approve 之前，auto 模式危险操作从静默批准改为必问（无人值守降级 deny）；lock 版本同步 | ✅ 已执行 |
| 2026-08-14 | Phase 3 perf-lab 落地（stats/parsers/remote core + 3 工具 adapter）；真实 GPU 验收待环境 | ✅ 已执行 |

---

## 0. TL;DR 决策摘要

**核心策略**（已与所有者确认）：

1. 以本仓库为主体，改造为**个人专属 packages**，长期排除大部分第三方包，降低维护面、便于自主演进与迁移。
2. Kimi Code 兼容层**彻底删除**（不用 Kimi Code）。
3. 四大目标场景：① 开放式技术探索（性能/系统优化向）② 聚焦式优化（算子级）③ 大型仓库扩展/维护（稳定性优先）④ 论文创新/写作/润色/评审（LaTeX + Markdown/Word 混合）。

**模块处置一览**（详见 §4）：

| 处置 | 模块 | 代码量 |
|---|---|---|
| ✅ 保留增强 | Goal、Ask、Todo、Plan、Permission(精简)、TUI、Pause、Truncation | 8,604 行 |
| ❌ 删除（被更好的实现替代或无需求） | Swarm、Task/Cron、Webfetch、Skills 扫描、Hooks(TOML)、Plugin、agent-file | 6,956 行 |
| ⚠️ 收敛为内部支撑 | tool-policy、completions、stream-rules、agent-lifecycle、profile、config | 随模块裁剪 |

**第三方包保留白名单**（详见 §5.3）：pi-subagents、pi-web-access、pi-mcp-adapter、pi-multiloop、pi-autoresearch、pi-lifeline、@lincoln504/pi-research、superpowers-zh。**排除**：pi-agent-extensions（其 ask_user/todo/sessions 等能力由本仓库补位）。

**新增选型**（学术场景，详见 §5.4）：academic-research-skills-pi-extension（全流程）、pi-bib（BibTeX 校验）、pi-critique（结构化批判润色）。

**自建缺口**（详见 §6）：LaTeX 工具链扩展、性能探索工具集（benchmark/profiling 解析）、实验知识沉淀桥。

---

## 1. 仓库现状全景

### 1.1 项目定位

本仓库 clone 自 [MuseLinn/pi-muselinn-harness](https://github.com/MuseLinn/pi-muselinn-harness) 0.9.22，是针对 [Pi coding agent](https://pi.dev) 的 "Kimi Code 风格" 编排 harness——把 Pi 刻意不做的功能（子代理、计划模式、todo 等）补齐为单一安装包（证据：README.md 第 3–20 行）。

- 架构：core/adapter 分层。`packages/core/` 纯逻辑零 pi 依赖；仓库根目录为 pi 适配层（证据：README "Architecture" 节 + packages/core/ports.ts）
- 质量：28 个测试套件、830+ 断言、纯 node 级无需模型配额（证据：tests/ 目录 + README "Tests" 节）
- CI：macOS + Ubuntu + Windows × Node 22/24/26 全矩阵（证据：.github/workflows/test.yml badge）
- 兼容：pi 0.81.x–0.83.x（当前环境 0.84.1，`package.json` devDeps 锁 0.83，需升级验证）

### 1.2 模块清单（工具 + 命令 + 代码量）

代码量统计方式：`find <dir> -name "*.ts" | xargs cat | wc -l`（2026-08-14 实测）。

| 模块 | 注册的工具 | 命令 | core 行数 | adapter 行数 | 功能要点 |
|---|---|---|---|---|---|
| **Swarm** | `agent_swarm`、`agent`、`agent_file_list`、`agent_file_info` | `/swarm` `/tasks` `/cancel` `/resume` `/steer` `/swarm-status` | 1,410 | 1,842 | 进程内子代理（coder/explore/plan 三型）、max_concurrency 工作池、30min 超时、盲文进度条、任务浏览器 |
| **Goal** | `create_goal` `get_goal` `update_goal` `set_goal_budget` | `/goal` | 1,828 | — | 目标生命周期（active/paused/blocked/complete/usage_limited/budget_limited）、三重预算（token/turn/wall-clock）、FIFO+优先级队列、完成标准门控、单调恢复、上下文注入 |
| **Plan** | `enter_plan_mode` `exit_plan_mode` | `/plan` | 1,083 | — | 计划模式（只读探索→审批→执行）、路径守卫、plan 文件三重匹配、系统提示注入 |
| **Permission** | （策略层，无工具） | `/mode` | 1,113 | — | 18 级策略链（auto/yolo/manual）、破坏性命令正则识别、敏感文件守卫（.env/id_rsa/*.key）、会话指纹审批、子代理同链门控 |
| **Task/Cron** | `run_background` `task_list` `task_output` `task_stop` `cron_create` `cron_list` `cron_delete` | — | 611 | 598 | 后台任务（50 上限/7 天清理/增量持久化）、5 字段 cron + 确定性 jitter |
| **Ask** | `ask_user_question` | — | 582 | 949 | 1–4 问题页签对话框、multi-select、选项级 Markdown 预览、Chat 出口、RPC 降级；123 断言 |
| **Todo** | `todo_list` | `/todo` | 741 | 542 | 阶段模型（罗马数字）、行内面板、完成自动淡出、Markdown 导入导出、停止时提醒注入 |
| **TUI** | — | `/tui` | 722 | 493 | 闭盒编辑器（plain/boxed/compact）、边框 spinner+模型名、shimmer 扫光动画、渲染计时探针 |
| **Pause/Steer** | — | `/pause` `/steer` | 287 | 195 | 全屏冻结（安全边界停车不中断）、暂停计时、运行中子代理消息注入 |
| **Webfetch** | `fetch_url` | — | 74 | 87 | 无鉴权 URL 抓取、HTML→文本提取、20k 字符上限 |
| **Hooks** | — | — | 796 | — | Kimi `config.toml` `[[hooks]]` 兼容引擎、16 事件、exit-code 语义、零依赖 TOML 解析 |
| **Skills** | `resources_discover` | — | 638 | — | 七作用域扫描（含 .kimi-code/.agents 兼容层）、frontmatter 解析、子代理分发 |
| **Plugin** | — | `/plugins` | 181 | 188 | `muselinn.plugin.json` 声明式 bundle（skills/sessionStart/hooks/commands） |
| **Truncation** | — | — | 69 | (内联) | 窗口感知的工具结果磁盘溢出（threshold = max(40k, window×4 chars/token)，上限 800k） |
| **agent-file** | （支撑 agent_file_* 工具） | — | 531 | — | Kimi 代理文件发现/解析 |
| **其他支撑** | — | — | ~800 | — | tool-policy、completions、stream-rules、agent-lifecycle、profile、config、text-utils、shell-output |

### 1.3 已安装第三方生态（对比基准）

来自 `~/.pi/agent/settings.json`（9 包）+ `mcp.json`（Zotero MCP），实测于 2026-08-14：

| 包 | 提供的能力（本会话实测工具） | 规模/活跃度 |
|---|---|---|
| **pi-subagents** | `subagent`（单子代理/workflowScript 编排/schedule.create 定时/mission 持久任务/worktree 隔离/resume 续跑/steer 转向）、`subagent_wait`、`workflow`、`intercom`/`subagent_supervisor` | nicobailon 维护，piext.tech 精选 |
| **pi-web-access** | `web_search`（20+ 提供商 fallback 链）、`fetch_content`（GitHub 克隆/PDF/YouTube/视频帧）、`source_check` | gallery 前列 |
| **pi-mcp-adapter** | `mcp`、`mcpScript`（按需发现 MCP 工具，~200 token 代理模式） | 配置了 Zotero（20 工具） |
| **pi-multiloop** | `multiloop_start/iterate/measure/decide/log/resume/pause/stop/archive`：同 worktree 多 lane 循环、optimize/research/dev/punchlist 四模式、复合验证器、MAD 噪声置信度、JSONL 持久史 | README：专为 CUDA kernel 调优+量化扫参场景设计 |
| **pi-autoresearch** | `init_experiment/run_experiment/log_experiment` + `/autoresearch` 模式 + 实时仪表盘 | 受 karpathy/autoresearch 启发 |
| **pi-lifeline** | `phone_a_friend`（卡住/平台期时求助强模型，限频策略） | 与 autoresearch 联动 |
| **@lincoln504/pi-research** | `research`（本地隐身浏览器免费搜索+深度研究）、`research_knowledge_search`（本地知识库） | 免 API 配额 |
| **superpowers-zh** | 20 个流程技能：brainstorming、TDD、systematic-debugging、writing-plans、executing-plans、requesting/receiving-code-review、git-worktrees、4 个中文场景技能 | 250k+ ⭐ 项目汉化 |
| **pi-agent-extensions** | 17 扩展 4 主题：`ask_user`、`todo`、sessions、handoff、review、loop、files、notify、context、control、answer、btw、powerline-footer、session-breakdown、workflow、whimsical、cwd-history | jayshah5696 维护 |
| **（原生 pi）** | read/write/edit/bash、`send_to_session`/`list_sessions`、`health`、扩展热重载、原生 skills/prompts/themes 机制 | pi 0.84.1 |

---

## 2. 逐项重叠对比与推荐

> 对比原则：以"四大场景 + 个人维护成本"为准绳。每项给出结论与理由；**[已验证]** 指本机实测（工具行为/代码/测试），**[调研]** 指基于 README/npm 文档。

### 2.1 Swarm（agent/agent_swarm） vs pi-subagents —— 推荐：**删除 harness Swarm，保留 pi-subagents**

| 维度 | harness Swarm | pi-subagents |
|---|---|---|
| 运行模型 | 进程内 `createAgentSession()`，共享宿主 | 子 Pi 会话（spawned-process），天然隔离 |
| 并发 | `runProgressive()` 工作池 + max_concurrency | runs.all 并行 + usageBudget 总量预算 |
| 隔离 | 无 worktree 概念 | `worktree:true` 每 child 独立 worktree（大仓库改造刚需） |
| 可恢复 | 保守语义：同 id 重跑+校验（README 自标 ⚠️） | `resume:<runId>` 续跑保留 agent 契约；async 状态机完整 |
| 持久任务 | 无 | mission（durable）+ `schedule.create`（every/at 定时） |
| 转向 | `/steer` | 内建 steer/interrupt/follow_up/auto 四模式 |
| 生态位 | 自成体系，Kimi 语义 | intercom/supervisor 跨会话协作族 |

**理由**：pi-subagents 在隔离性（worktree）、可恢复性（resume/mission）、调度（schedule）上全面占优，且是多包协作家族的枢纽；harness Swarm 的核心卖点（盲文进度条、任务浏览器）是 UI 层，逻辑可低成本移植到 TUI 模块。**[已验证]** 两者工具名不同（`agent` vs `subagent`）不会撞名崩溃，但并存会让模型在两套子代理语义间摇摆，徒增 token 与不确定性。

### 2.2 Ask（ask_user_question） vs 原生 ask_user（pi-agent-extensions） —— 推荐：**保留 harness Ask，随 pi-agent-extensions 排除而补位**

- harness Ask：页签式多问题对话框、multi-select、选项级 Markdown 预览、`Chat about this` 出口、后台任务可提问、RPC 降级渲染；**123 断言**（tests/ask.test.mjs）**[已验证]**
- pi-agent-extensions ask-user：结构化提问（Beta 状态）**[调研：其 README 扩展表]**
- 本会话的 `ask_user` 工具即 pi-agent-extensions 提供，功能上是 harness Ask 的子集（无预览/无页签/无 Chat 出口）。

**理由**：按"排除 pi-agent-extensions"策略，Ask 是 harness 补位的关键模块，质量与测试密度均占优。

### 2.3 Todo（todo_list） vs 原生 todo（pi-agent-extensions） —— 推荐：**保留 harness Todo 并补位**

- harness Todo：阶段模型、行内面板、自动淡出、Markdown 往返、停止时 `<system-reminder>` 注入、子代理匹配高亮；99 断言 **[已验证]**
- 原生 todo（.pi/todos）：claim/release 协作、title+body markdown，功能较朴素 **[已验证：本会话工具描述]**

**理由**：同上，排除 pi-agent-extensions 后由 harness 补位；建议吸收原生 todo 的 `claim/release` 多会话防冲突语义（唯一落后点）。

### 2.4 Webfetch（fetch_url） vs pi-web-access / pi-research —— 推荐：**删除 harness Webfetch**

fetch_url（161 行）是无鉴权单 URL 抓取；pi-web-access 的 `fetch_content` 覆盖 GitHub 克隆/PDF/YouTube/视频帧 + 多提供商搜索 fallback；pi-research 提供免费隐身浏览器搜索 + 知识库。完全冗余，且 fetch_url 无任何鉴权/SSRF 防护细节描述。**[已验证：本会话 fetch_content 实测可用]**

### 2.5 Task/Cron vs pi-subagents schedule —— 推荐：**删除 harness Task/Cron**

- pi-subagents `schedule.create`：`at`（一次性）+ `every`（间隔）+ 持久化 + `catchUp` 策略 + pause/resume/history 全生命周期管理 **[已验证：本会话工具描述]**
- harness cron：5 字段 cron + jitter + 50 上限 + 7 天清理（1,209 行）
- 差异点仅剩"标准 cron 表达式"一种表达方式，不足以支撑独立模块。`run_background`/`task_output` 与 pi-subagents 的 async 模式（asyncId/status/output 落盘）重叠。

### 2.6 Plan vs pi 原生 —— 推荐：**保留 harness Plan（场景 3 刚需），做安全精简**

**关键事实**：pi 官方 README 明言 "Pi ships with powerful defaults but skips features like sub agents and plan mode" —— plan mode 不是原生能力 **[调研：pi README]**；gallery 中另有 @zhushanwen/pi-plan 与 @narumitw/pi-plan-mode 两个第三方实现，佐证这是生态普遍自建的空白。

- harness Plan 的差异化：审批门控 + 只读探索 + revise 保留计划 + 恢复校验；42 断言 **[已验证]**
- superpowers-zh 的 brainstorming→writing-plans 流程是"方法论层"，与 Plan 的"机制层"（工具拦截 + 路径守卫）互补而非替代。
- 精简点：删除与 Kimi 权限模型的耦合分支（bash 不受限逻辑保留）、简化为场景 3 服务的白名单。

### 2.7 Permission vs pi 原生权限 —— 推荐：**保留核心守卫，删除 Kimi 层级与 18 级全链**

- 保留价值：破坏性命令正则识别（rm -rf / git push --force / drop table）、敏感文件守卫（.env/id_rsa/*.key）、会话指纹审批 —— 三者是场景 3"稳定性关键"的直接保障，且 auto 模式下的自动化探索（场景 1/2）也依赖"危险操作永远问"的底线。
- 删除项：AGENTS.md 的 Kimi 层级（`.kimi-code/AGENTS.md`、`$KIMI_CODE_HOME`）、18 级链中为 Kimi 对齐的部分档位。pi 原生已有 trust.json + ask_user 审批，harness 只做**增量守卫**而非全链替换。

### 2.8 Goal vs pi-multiloop/pi-autoresearch 的目标机制 —— 推荐：**保留 harness Goal（互补，非重叠）**

- multiloop/autoresearch 是"单循环执行引擎"（metric→iterate→measure→decide），Goal 是"跨循环的目标层"（预算三重门控 + 队列 + 完成标准验证 + compaction 恢复）。一个管"怎么跑"，一个管"跑多久、跑到什么算完、跑不完排队"。
- Goal 1,828 行 + 32 断言 + 单调恢复设计（stale entry 不会拉回计数器）**[已验证]**，是 harness 最厚的模块，也是四大场景共同需要的能力底座。
- 可选演进：为 Goal 增加"适配器"直接驱动 multiloop lane（Goal 定目标/预算，multiloop 执行），形成个人生态内闭环。

### 2.9 Skills 扫描 vs pi 原生 skills —— 推荐：**删除 harness Skills 模块**

pi 原生已有完整的 skills 发现/加载/`/skill:` 调用机制（本会话 28 个可用技能即证）**[已验证]**。harness 的七作用域扫描器中 4/7 是为 Kimi/跨工具兼容设计，删除 Kimi 兼容后仅剩微弱增量。

### 2.10 Hooks（TOML 引擎） vs pi 事件系统 —— 推荐：**删除**

`config.toml [[hooks]]` 是 Kimi Code 的配置形态；pi 扩展本身可直接订阅 `pi.events`。删除 Kimi 兼容层后此模块失去存在意义（16 事件的"镜像到 pi.events"恰恰说明它是转接件）。

### 2.11 Plugin（声明式 bundle） vs pi packages —— 推荐：**删除**

pi 原生 package 系统（`pi` manifest：extensions/skills/prompts/themes + gallery 分发）完全覆盖 `muselinn.plugin.json` 的能力且是官方标准。个人仓库改造后自身就是一个 pi package，不需要包内再造包。

### 2.12 Pause/Steer、TUI、Truncation —— 推荐：**保留（无重叠的差异化能力）**

- Pause：全屏冻结 + 安全边界停车，pi 生态无等价物（pi-subagents 的 interrupt 是取消语义，不是停车语义）。
- Steer：与 pi-subagents steer 重叠（见 2.1），保留 pause、删 `/steer`（改用 subagent steer），减少双轨。
- TUI：闭盒编辑器/shimmer 为纯审美差异化，与 pi-lens/powerline-footer 不冲突；保留但冻结功能开发。
- Truncation：窗口感知磁盘溢出（大输出场景 1/2 的 benchmark 日志刚需），pi 原生截断（2000 行/50KB 截断丢弃）不如其保留可分页读取的溢出文件。69 行核心，性价比极高。

---

## 3. 四大场景能力矩阵

图例：✅ 已覆盖（本仓库）｜✅3rd 已覆盖（保留白名单第三方包）｜🟡 部分｜🆕 缺口（需新增/自建）

| 能力需求 | 场景1 开放探索 | 场景2 算子优化 | 场景3 仓库维护 | 场景4 论文 | 提供方 |
|---|---|---|---|---|---|
| 长目标/预算/队列管理 | ✅ | ✅ | ✅ | ✅ | harness Goal |
| 实验循环（metric→keep/revert） | ✅3rd | ✅3rd | — | — | pi-multiloop |
| 实验记录+仪表盘 | ✅3rd | ✅3rd | — | 🟡 | pi-autoresearch |
| 卡住求助强模型 | ✅3rd | ✅3rd | — | — | pi-lifeline |
| 并行子代理/隔离 worktree | 🟡 | 🟡 | ✅3rd | — | pi-subagents |
| 定时/持久任务 | ✅3rd | ✅3rd | — | — | pi-subagents schedule |
| 计划门控（探索→审批→执行） | — | — | ✅ | 🟡 | harness Plan |
| 危险操作守卫 | ✅ | ✅ | ✅ | — | harness Permission(精简) |
| 结构化提问/任务面板 | ✅ | ✅ | ✅ | ✅ | harness Ask/Todo |
| 冻结检查（pause） | ✅ | ✅ | 🟡 | — | harness Pause |
| 大输出溢出可读 | ✅ | ✅ | — | — | harness Truncation |
| 方法论流程（TDD/review/plans） | — | 🟡 | ✅3rd | — | superpowers-zh |
| Web 搜索/深度研究 | ✅3rd | 🟡 | ✅3rd | ✅3rd | pi-web-access + pi-research |
| 文献库（Zotero） | — | — | — | ✅3rd | Zotero MCP（已配） |
| 学术写作全流程 | — | — | — | 🆕 | 选型 §5.4 |
| BibTeX/引用校验 | — | — | — | 🆕 | 选型 §5.4 |
| 写作批判/润色 | — | — | — | 🆕 | 选型 §5.4 |
| LaTeX 编译/纠错 | — | — | — | 🆕 | **空白，需自建 §6.1** |
| benchmark/profiling 解析 | ✅🆕 | ✅🆕 | — | — | **空白，需自建 §6.2** |
| 实验结果→知识沉淀 | 🆕 | 🆕 | — | 🟡 | **需自建桥 §6.3** |
| lint/LSP/索引直达 agent | — | — | 🆕 | — | 可选 §5.5 |

**场景结论**：
- **场景 1/2** 的引擎（multiloop/autoresearch/lifeline）生态成熟且正好为性能优化设计（multiloop README 原文提到 CUDA kernel 调优场景），白名单保留 + Goal 做目标层即可成型；真正缺的是 **§6.2 性能探索工具集**。
- **场景 3** 是本仓库改造后的主场：Plan + Permission + Ask/Todo 补位 pi-agent-extensions，与 superpowers-zh 方法论、pi-subagents 隔离审查形成三层防线。
- **场景 4** 生态意外地丰富（7 个学术包），选型组合后仅 LaTeX 工具链是真空白。

---

## 4. 模块处置总表（改造执行清单）

| # | 模块 | 处置 | 后续动作 | 预估工作量 |
|---|---|---|---|---|
| 1 | Goal（1,828 行） | ✅ 保留增强 | 删 Kimi 痕迹；增加 multiloop lane 适配器（可选） | 0.5d + 2d |
| 2 | Ask（1,531 行） | ✅ 保留增强 | 对齐 pi-agent-extensions 排除后的接口空缺；评估改名 `ask_user` 接管 | 1d |
| 3 | Todo（1,283 行） | ✅ 保留增强 | 吸收原生 todo 的 claim/release 语义 | 1d |
| 4 | Plan（1,083 行） | ✅ 保留精简 | 删 Kimi 权限模型耦合分支；保留路径守卫与审批门控 | 1d |
| 5 | Permission（1,113 行） | ⚠️ 精简保留 | 只留破坏性命令/敏感文件守卫 + 会话指纹；删 18 级链与 AGENTS.md Kimi 层级 | 2d |
| 6 | TUI（1,215 行） | ✅ 保留冻结 | 冻结新功能；随 pi-tui API 升级维护 | 0.5d |
| 7 | Pause（482 行） | ✅ 保留 | 删 `/steer`（用 pi-subagents steer 替代） | 0.5d |
| 8 | Truncation（69 行） | ✅ 保留 | 无需改动 | 0d |
| 9 | Swarm（3,252 行） | ❌ 删除 | 可选：把任务浏览器 UI 移植为 pi-subagents 的可视化面板（后续创意） | 删 0.5d / 移植 3d |
| 10 | Task/Cron（1,209 行） | ❌ 删除 | 由 pi-subagents schedule/async 覆盖 | 0.5d |
| 11 | Webfetch（161 行） | ❌ 删除 | 由 pi-web-access 覆盖 | 0.1d |
| 12 | Skills（638 行） | ❌ 删除 | pi 原生 skills 覆盖 | 0.5d |
| 13 | Hooks（796 行） | ❌ 删除 | Kimi config.toml 形态失去意义 | 0.5d |
| 14 | Plugin（369 行） | ❌ 删除 | pi 原生 package 系统覆盖 | 0.5d |
| 15 | agent-file（531 行） | ❌ 删除 | Kimi 代理文件概念，随 Swarm 删 | 0.2d |
| 16 | 支撑模块（~800 行） | ⚠️ 随动 | tool-policy/completions/stream-rules/agent-lifecycle/profile/config 按存活模块依赖裁剪 | 1d |
| 17 | 仓库标识 | 🔄 改造 | 改名（pi-muselinn-harness → 个人包名）、改 package.json/keywords/pi manifest、清 docs 站点、重写 README | 1d |
| 18 | pi 0.84 适配 | 🔄 升级 | devDeps 0.83 → 0.84，跑全测试矩阵 + typecheck | 0.5d |

**Kimi 兼容层专项清理**：52 个文件含 kimi/KIMI 字样、42 处 `kimi-code/KIMI_CODE_HOME` 引用（grep 实测），分布在 skills/hooks/permission/profile/task 等模块，随对应模块删除或专项清理。

**预期收益**：删除 6,956 行低价值代码（含全部 Kimi 兼容负担），核心保留 8,604 行高测试密度代码（行数均为 §1.2 表中 core+adapter 实测之和）；仓库从"Kimi 复刻"转型为"个人四大场景底座"。

---

## 5. Pi Packages 生态调研

### 5.1 生态规模

- npm `pi-package` 关键字：**~5,890 个包**；pi.dev gallery 收录 **~5,384**（gallery 使用 npm search API，新包/低分包可能滞后入册）**[调研：github.com/earendil-works/pi/issues/6991]**
- 第三方索引：[piext.tech](https://piext.tech)（6,207 包、12 分类、安全审计标注）、[pi-package 索引 API](https://pi-package.rectorspace.com)（每日刷新、含 stars/维护度排序）
- 官方文档：[pi.dev/packages](https://pi.dev/packages) · [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

### 5.2 通用类候选（按需评估，暂不引入）

| 包 | 功能 | 与个人生态关系 |
|---|---|---|
| @zhushanwen/pi-subagent-workflow | 进程 spawn 子代理 + 状态机工作流 | 与 pi-subagents 重叠，不引入 |
| @zhushanwen/pi-permission | 4 模式权限（AST+规则+AI 分类器三层） | AI 分类器思路可借鉴到 Permission 精简 |
| @zhushanwen/pi-scheduler / pi-plan / pi-model-switch | 调度/轻量 plan/模型切换 | 均被白名单或本仓库覆盖 |
| pi-fabric | 可编程工具与 agent 运行时 | 观望 |
| pi-hermes-memory / pi-memory | 跨会话记忆 | pi-research 知识库已覆盖主需求 |
| pi-background-tasks、@quintinshaw/pi-dynamic-workflows、@narumitw/pi-goal/pi-plan-mode/pi-lsp | 后台任务/动态工作流/goal/plan/LSP | 各方向均已有更强实现（goal 尤其：本仓库 1,828 行版更强） |

### 5.3 保留白名单（现有 9 包的处置）

| 包 | 处置 | 理由 |
|---|---|---|
| pi-subagents | ✅ 保留 | 子代理基础设施枢纽（worktree/resume/mission/schedule/intercom），自建成本 >> 维护成本 |
| pi-web-access | ✅ 保留 | 搜索/抓取基础设施，20+ 提供商 fallback，不可自建替代 |
| pi-mcp-adapter | ✅ 保留 | MCP 省上下文代理模式（~200 token/服务器），Zotero 依赖它 |
| @lincoln504/pi-research | ✅ 保留 | 免费本地浏览器搜索 + 知识库（research_knowledge_search），独有 |
| pi-multiloop | ✅ 保留 | 场景 1/2 核心引擎；多 lane/MAD/复合验证器均为刚需设计 |
| pi-autoresearch | ✅ 保留 | 实验记录与仪表盘，与 multiloop 互补 |
| pi-lifeline | ✅ 保留 | 卡住求助机制，长时自动化必备 |
| superpowers-zh | ✅ 保留 | 方法论技能层，场景 3 主力；含中文场景技能 |
| **pi-agent-extensions** | ❌ **排除** | 17 扩展大杂烩：ask_user/todo 由本仓库 Ask/Todo 补位（质量占优）；sessions/handoff/review 等单独评估是否需要个别移植 |

### 5.4 学术场景选型（场景 4 新增）

调研发现的 pi 生态学术包全表 **[调研：npm/GitHub README]**：

| 包 | 核心能力 | 许可 | 推荐度 |
|---|---|---|---|
| **@portos-wang/academic-research-skills-pi-extension** | Claude Code 移植：4 核心 skill、27 模式、39-agent 集群（Deep Research 13-agent/PRISMA、Paper 12-agent、Reviewer 7-agent、Pipeline 10-stage）；`/ars-*` 命令族 | **CC-BY-NC-4.0**（个人使用 OK，禁商用） | ⭐⭐⭐⭐⭐ 首选 |
| **pi-bib** | .bib 对 CrossRef+Semantic Scholar 校验；Better BibTeX 同源解析器；DOI 优先；安全建议文件隔离输出 | MIT | ⭐⭐⭐⭐⭐ 刚需 |
| **pi-critique**（omaclaren） | 结构化批判：C1/C2 编号批评+行内标记；academic lens（methodology/citation/logic/scope）；非破坏性 | MIT | ⭐⭐⭐⭐ 润色主力 |
| linlic-agent | /search /paper /idea /experiment /review /revise /citation-check 科研命令族；Semantic Scholar+OpenAlex+arXiv+Zotero | 开源（repo） | ⭐⭐⭐ 可参考其命令划分 |
| pi-research-workbench | 10 skill 科研管线（topic-story→…→submission-package）+ 确定性 validator + 期刊规则包 | 开源 | ⭐⭐⭐ 审稿侧参考 |
| Aspis0/pi-paper-lab | 生物医学论文+Vancouver 引用+Word 原生引用域+反 AI 检测 | 开源 | ⭐⭐ 领域过窄（bio/docx），但 Word 引用域技术可借鉴 |
| @fbraza/pi-cite | PubMed/Zotero 检索三工具 + literature skill | 开源 | ⭐⭐⭐ PubMed 场景按需（用户 Zotero MCP 已覆盖 Zotero 侧） |

**推荐组合**：academic-research-skills（全流程骨架）+ pi-bib（BibTeX 质检）+ pi-critique（批判润色），三者 MIT/NC 许可均允许个人使用，先装试用再决定吸收。

**LaTeX 缺口佐证**：以上 7 包无一提供 LaTeX 编译/纠错能力；Claude/Codex 生态的 [appautomaton/latex-arxiv-SKILL](https://github.com/appautomaton/latex-arxiv-SKILL)（门控写作+引用验证+pdflatex 强制通过）证明该模式可行但 pi 生态空白 → 列入自建 §6.1。

### 5.5 场景 3 可选增强（大仓库维护）

| 包 | 功能 | 建议 |
|---|---|---|
| **pi-lens** | linters/formatters/type-checking/结构分析直达 agent | ⭐⭐⭐⭐ 建议试用；与本仓库 Permission 形成"守卫+反馈"闭环 |
| @narumitw/pi-lsp | LSP 集成 | ⭐⭐⭐ 视 pi-lens 覆盖度决定 |
| opencode-codebase-index | 代码库索引 | ⭐⭐⭐ 超大仓库时评估 |
| pi-simplify | 最近改动清晰度审查 | ⭐⭐ superpowers review 流程已覆盖 |

---

## 6. 自建缺口分析（个人 packages 新增路线）

### 6.1 LaTeX 工具链扩展 `latex-toolchain`（场景 4，优先级高）

生态现状：pi 生态无 LaTeX 工具包；latex-arxiv-SKILL（Claude/Codex Agent Skill 标准）可作设计蓝本 **[调研]**。

建议设计：
- 工具 `latex_compile`：latexmk/pdflatex+bibtex 封装，错误行结构化解析（文件:行:错误码），返回可操作的修复建议而非原始日志
- 工具 `bibtex_check`：未定义引用/重复 key/孤儿条目（pi-bib 负责元数据正确性，本工具负责引用一致性）
- 命令 `/latex watch`：保存触发增量编译 + 错误面板（复用本仓库 TUI 组件能力）
- 与 pi-bib、Zotero MCP（BibTeX 导出）、academic-research-skills 的 `/ars-*` 命令衔接

预估：扩展 ~600 行 + skill ~200 行。

### 6.2 性能探索工具集 `perf-lab`（场景 1/2，优先级高）

生态现状：multiloop/autoresearch 提供"循环与决策"，但**测量侧**（benchmark 稳定化、profiler 输出解析）完全空白。

建议设计：
- 工具 `bench_run`：基准命令封装——预热轮、N 次重复、P50/P95/P99 统计、MAD 离群剔除（与 multiloop 的 MAD 语义对齐）、环境快照（GPU 型号/驱动/时钟锁定状态）
- 工具 `profile_parse`：`nsys`/`ncu`/`perf` 输出解析为结构化 JSON（热点表、内核耗时、带宽利用率），供 agent 直接推理
- 工具 `metric_compare`：两次运行的统计显著性判断（避免噪声驱动的错误 keep/revert）
- 与 Goal（预算）+ multiloop（循环）+ lifeline（卡住升级）串成完整场景 1/2 链路

预估：~900 行（解析器为主，纯逻辑进 packages/core，延续本仓库分层惯例）。

### 6.3 实验知识沉淀桥（场景 1/2/4，优先级中）

痛点：multiloop 的 JSONL 历史 + autoresearch 的 log.jsonl 分散在各仓库，无法跨项目检索；pi-research 知识库只收 web 研究成果。

建议设计：
- 命令 `/explore-sync`：把 loop 历史/实验结论蒸馏为结构化条目（假设/结果/教训/复现命令），写入 pi-research 知识库
- 论文侧同一数据可喂给 academic-research-skills 的实验章节写作
- 预估 ~300 行

### 6.4 待评估（暂不开工）

- pi-agent-extensions 个别扩展的移植（sessions/handoff/notify/powerline-footer 视淘汰后使用痛感）
- Word 引用域输出（借鉴 pi-paper-lab 的 bun-docx 方案，仅当 Word 投稿成为高频需求）
- Swarm 任务浏览器 UI 移植为 pi-subagents 可视化面板（创意项）

---

## 7. 目标架构与分阶段迁移路线

### 7.1 目标架构（改造后）

```
个人 pi 生态
├── 本仓库（个人 harness，单一 pi package）
│   ├── 核心：Goal / Plan / Permission(守卫) / Ask / Todo / Pause / TUI / Truncation
│   ├── 新增自建：latex-toolchain / perf-lab / explore-sync
│   └── packages/core 纯逻辑分层（延续现有架构）
├── 白名单第三方（8 包）：pi-subagents / pi-web-access / pi-mcp-adapter /
│   pi-multiloop / pi-autoresearch / pi-lifeline / pi-research / superpowers-zh
├── 学术新增（3 包，试用后定去留）：academic-research-skills / pi-bib / pi-critique
└── MCP：Zotero（已配，经 pi-mcp-adapter）
```

### 7.2 分阶段路线

**Phase 0 — 立项准备（0.5d）**
- 改名与标识：package.json（name/author/keywords/repository）、README 重写为个人版、docs/ 站点处理（保留或删除 GitHub Pages）
- 建 `main` 分支保护前先跑通基线：`npm test && npm run typecheck`（28 套件全绿为基线证据）

**Phase 1 — 减法（~3d）**
- 删除：Swarm、Task/Cron、Webfetch、Skills、Hooks、Plugin、agent-file + 全部 Kimi 兼容痕迹（§4 清单 #9–#15）
- 同步删除对应测试套件与 README 章节；每删一个模块跑一次全测试
- 验收：typecheck 零错误、测试全绿、`pi -e .` 本地加载无警告

**Phase 2 — 精简与补位（~5d）✅ 已完成**
- Permission 精简为守卫层；Plan 去 Kimi 耦合；Todo 吸收 claim/release；Pause 删 /steer（后者在 Phase 1 任务 7 提前完成）
- 排除 pi-agent-extensions（`pi remove npm:pi-agent-extensions`），验证 Ask/Todo 补位无感（任务 8）
- 升级 devDeps 至 pi 0.84.2 并全矩阵验证（typecheck + 14 套件全绿）

**Phase 2 死代码清扫清单（终审后登记）✅ 已完成**
- 已清扫：`packages/core/profile/`、`packages/core/config/`、tool-policy 休眠 setter 层、`permission` 的 `evaluateForSubagent`、`packages/renderer/`、`packages/core/agent-lifecycle/`（删除）
- muselinn 兼容命名保留清单：已改名 `lamboy-tui.json`、`PI_LAMBOY_*` 环境变量、`lamboy_goal/plan/permission/todo` entry 类型、`pi-lamboy-harness` tmpdir 回退名
- 后续增强（非阻塞）：todo markdown export/import 不往返 claim 状态（与 `details`/`notes` 同属已知有损格式）

**Phase 3 — 性能探索成型（~1 周，优先级提升） ✅ 已完成（2026-08-14）**
- perf-lab（§6.2）已落地：core 层（stats/parsers/remote 纯逻辑）+ adapter 3 工具（bench_run / profile_parse / metric_compare），18 套件全绿、typecheck 0、`pi -e` 加载确认三工具注册
- 验收状态：mock-ssh 覆盖完成；**真实 GPU 验收（kunshan-quant 上的实际 kernel）待环境可用时补验**
- 待办：打通 Goal→multiloop→perf-lab→lifeline 链路，长时无人值守跑一轮（随真实 GPU 验收一起）

**Phase 4 — 学术场景成型（~1 周）**
- 安装试用 academic-research-skills / pi-bib / pi-critique，跑通一篇已有论文的 review→revise→bib-check 流程
- 自建 latex-toolchain（§6.1），以一篇真实 LaTeX 稿件为验收对象

**Phase 5 — 沉淀与回访（持续）**
- explore-sync（§6.3）；每季度回访白名单包的活跃度，评估进一步吸收或替换

### 7.3 风险与对策

| 风险 | 对策 |
|---|---|
| pi 0.84+ API 变更破坏 adapter 层 | devDeps 跟随 pi 主版本；CI 矩阵保持三平台 |
| pi-agent-extensions 排除后遗漏能力（notify/context 等） | 排除前盘点 17 扩展的实际使用频率（session 日志可查），逐项确认 |
| academic-research-skills CC-BY-NC 许可 | 仅个人使用，不分发衍生；若需商用再评估替换 |
| 删除模块后测试基线变化 | Phase 1 起维护新的基线快照，PR 粒度删模块 |

---

## 8. 附录：证据与来源

**本仓库（实测）**
- 模块行数：`find <dir> -name "*.ts" | xargs cat | wc -l`（2026-08-14，§1.2 表）
- 工具注册点：index.ts:575,586,780,1257,1531,1558；ask/index.ts:186；todo/index.ts:291；task/index.ts:312,371；webfetch/index.ts:50；packages/core/task/cron.ts:405
- Kimi 痕迹：52 文件 / 42 处 `kimi-code|KIMI_CODE_HOME`（grep -ril 实测）
- 测试基线：tests/ 目录 28 套件（README 称 830+ 断言）

**已安装生态（实测）**
- `~/.pi/agent/settings.json`（9 包清单）、`mcp.json`（Zotero）
- 各包 README：`~/.pi/agent/npm/node_modules/<pkg>/README.md`
- pi-agent-extensions 17 扩展清单：pi.dev/packages/pi-agent-extensions + 本地 extensions/ 目录
- 本会话实际可用的工具行为（subagent/workflow/multiloop_*/phone_a_friend/research/ask_user/todo 等）

**生态调研（web，2026-08-14）**
- pi.dev/packages gallery；npm `keywords:pi-package` 搜索（~5,890 包）
- 学术包：github.com/portos-wang/pi-extensions（academic-research-skills）、npm pi-bib、github.com/omaclaren/pi-critique、github.com/linlic2005/linlic-agent、npm pi-research-workbench、github.com/Aspis0/pi-paper-lab、npm @fbraza/pi-cite、github.com/appautomaton/latex-arxiv-SKILL
- 索引站：piext.tech（6,207 包）、pi-package.rectorspace.com（API）
- 规模佐证：github.com/earendil-works/pi/issues/6991（gallery 收录机制与 ~5,890 npm 计数）
- pi 官方文档：pi.dev/docs/latest/packages、github.com/earendil-works/pi（README/monorepo 结构）

**推测标注**
- §4 工作量为经验估值（未执行验证），按"删→测→提交"粒度给出的日级估算
- §5.2/§5.5 推荐度基于 README 功能对照，未逐一实装验证；academic 三包建议"先试用后吸收"
