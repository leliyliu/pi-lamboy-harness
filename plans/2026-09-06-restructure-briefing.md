# 生态重构简报：自建详解 · 第三方拆解 · 个人局部收录（2026-09-06）

> 承接 `plans/2026-09-06-packages-ecosystem-audit.md`（全景审计）。本文回答三个问题：
> **A.** 自建 harness 中 Pause / TUI / Truncation 到底做什么（源码级详解）
> **B.** 第三方 13 包内部有哪些子功能、哪些能拆出来单独用、怎么保留更新追溯
> **C.** 个人局部扩展如何收录为可选装子包（已完成：`personal/`）
> 所有论断附证据（`file:line` 或官方文档节名）。

---

## Part A — 自建三大"隐形模块"详解

这三个模块与 Goal/Plan/Ask/Todo 不同：**没有显式工具入口或工作流**，属于"装上后悄悄改变体验"的基础设施。

### A.1 Pause（冻结检查）

**解决的问题**：agent 长时间运行时，你想临时停下来——看一眼它做到哪了、给别人演示、或单纯暂停烧钱——但**不想中断工作**。

**与"取消"的本质区别**（`packages/core/pause/gate.ts:1-12` 头注）：

| | 取消（pi 原生 Ctrl+C） | 停车（Pause） |
|---|---|---|
| 进行中的工具调用 | AbortSignal 打断 | **跑完为止**，绝不中止 |
| 恢复后 | 从头再来 | **从挂起点继续**，队列中消息正常投递 |
| 语义 | "这次作废" | "暂停会儿，别动" |

**实现原理**（gate.ts，108 行纯逻辑，零 pi 依赖）：
- 进程级单例 `AgentPauseGate`：一个 `Promise.withResolvers` 门闩。`pause()` 挂起门闩，`resume()` 解开并唤醒所有等待者（gate.ts:58-79）
- 每个会话的工具执行边界轮询 `waitUntilResumed()`——命中即 park（gate.ts:110-140，含"resume 后立刻 re-pause 不会漏网"的循环防御）
- **AbortSignal 只解开单个等待、不解门闩**（gate.ts:126-128）：取消某一个运行，其他冻结的会话保持冻结——门禁与运行解耦
- `pausedOrigin` 记录首次 park 的位置（如 `tool_call`），遮罩上显示 `<tool_call>` 标签

**交互**（`pause/commands.ts` + `pause/screen.ts`）：
- `/pause` → 全屏遮罩：主题色 ⏸ 符号 + 每秒自刷新的暂停计时（screen.ts:33-39 定时器只 requestRender）
- esc / enter / space / ctrl+c 释放（screen.ts:71-80）
- 恢复后在会话流留状态行：`已恢复（暂停 13s）— 代理继续运行`（screen.ts:120-125）
- 无交互 UI（如 RPC/print 模式）优雅拒绝：`Pause requires interactive UI`（commands.ts:14-17）；重复 /pause 提示 Already paused（screen.ts:98-101）

**布局细节**（`packages/core/pause/lines.ts`）：纯函数渲染，块字符（█）按单宽计量保证居中对齐；<64 列或 <18 行自动降级为紧凑卡片（lines.ts:33-36）。

**何时你会用到它**：挂机跑 GPU 基准（perf-lab）时临时检视中间状态；屏幕共享前暂停；多会话并行时冻结某个会话防止它抢着改文件。

**可拆性**：模块极小（gate 108 + lines ~200 + screen 123 + commands 22 行），与 harness 其他部分零耦合（gate 甚至不 import pi）。不想要它 = 不装 harness；已装则无配置开关，但纯被动（不按 `/pause` 永不触发，**零日常开销**）。

### A.2 TUI（编辑器外观层）

**解决的问题**：pi 默认编辑器只有上下横线、无状态信息。TUI 模块把它换成"闭合框 + 边框信息位"的编辑器，并在边框上显示实时工作状态。

**三种样式**（`/tui style <plain|boxed|compact>`，tui/index.ts:265-274）：

| 样式 | 长相 | 来源 |
|---|---|---|
| `boxed`（默认） | `╭─ spinner 工作状态 ── 模型名 ─╮` 闭盒边框，首行内容带 `│❯ ` 提示符 | Kimi Code `wrapWithSideBorders` 移植（box.ts，MIT 注释保留） |
| `compact` | 无侧边的顶栏：spinner 左 + 模型右（pi-spark 风格） | pi-spark 借鉴（README 致谢节） |
| `plain` | **注销自定义编辑器**，回到 pi 默认 | pi 原生 |

**边框信息位**（tui/index.ts:72-130）：
- 左槽：plan 徽标（plan 模式激活时显示，由 index.ts 注入 provider，tui/index.ts:56-68）→ spinner 帧（墙钟驱动，不依赖渲染节奏）→ 工作消息（Thinking / Streaming / Running tools）带 **shimmer 扫光动画**（`/tui shimmer classic|kitt|disabled`，光带亮头处 accent+bold 高亮）
- 右槽（可选，`modelInBorder: true`）：`provider · model:thinking-level`

**工作机制**（对性能敏感者）：
- 事件驱动状态机：`agent_start` → working；`message_update` 按 assistantMessageEvent 类型区分 Thinking/Streaming/Running tools；`tool_execution_start/end` 维护 runningTools 计数；`agent_settled` → 停止（tui/index.ts:222-262）
- **性能纪律**（tui/index.ts:1-15 头注 + 265-296）：no-op 状态更新直接跳过（流式 delta 每秒几十次重复断言同一状态）；keep-alive 定时器只在 >200ms 静默期补帧（≈10fps 上限），动画本身搭 pi 自然渲染的便车；`PI_LAMBOY_TUI_TIMING=1` 可开 P50/P99 渲染探针（`/tui timing` 查看）
- 热切换：`setEditorComponent` 工厂替换，pi 保留文本/焦点/补全/键位（editor.ts:1-10 头注）

**配置持久化**：`~/.pi/agent/lamboy-tui.json`（style / modelInBorder / shimmer），项目 `.pi/` 同名文件覆盖（README TUI 节）。

**何时你会感受到它**：任何时候打开 pi。**它是纯外观层，不影响任何 agent 行为**。讨厌就 `/tui style plain` 一键回原版。

**可拆性**：TUI 是 harness 中最大的纯体验模块（core/tui 8 文件 + adapter 492 行）。`/tui style plain` 等于事实性关闭；代码层面依赖 pi-tui 组件 API（setEditorComponent/custom editor），随 pi-tui 版本演进需要维护（roadmap §2.12"保留冻结"决策的依据）。

### A.3 Truncation（大输出落盘）

**解决的问题**：一个失控的 `npm test` / 编译日志 / nvidia-smi dump 可能几百 KB——pi 原生截断（2000 行/50KB 硬截）直接**丢弃**中间内容；塞进上下文又烧窗口。

**机制**（`packages/core/truncation/index.ts`，69 行核心，纯函数）：
1. 工具结果超过阈值 → **全文写盘** `<sessionDir>/tool-results/<toolName>-<callId>.txt`（truncationPathFor，index.ts:55-59）
2. 上下文里只留：净化后的**头 1500 字符 + 尾 500 字符 + 落盘标记**（buildTruncatedPreview，index.ts:61-73），标记内含 `output_path` 和"用 read (offset/limit) 分页读取"的指引——模型需要中间内容时自己去 read
3. 头尾均先过 `sanitizeShellOutput`（控制序列净化器，core/shell-output.ts），防止 ANSI 转义污染上下文

**窗口感知阈值**（index.ts:31-46，CHANGELOG 0.9.21 issue #2）：

```
threshold = max(40k 字符, 模型窗口 tokens × 4 字符/token)，上限 800k 字符（≈200k token）
```

8k 窗口模型保持 40k 默认；1M 窗口模型可保留最多 800k 字符的完整输出（免落盘往返）。`PI_TRUNCATION_THRESHOLD` 环境变量强制覆盖一切。

**何时你会感受到它**：场景 1/2（跑基准看长日志）、场景 3（大仓库全量 grep）中悄然生效。**被动模块，无命令无工具，唯一可见痕迹是输出末尾的 `[... output truncated: N chars ... full output saved to ...]` 标记**。

**可拆性**：69 行核心 + 21 断言（tests/truncation.test.mjs），roadmap 评价"性价比极高"。无配置开关，但默认行为对所有模型安全（窗口感知即为此设计）。

---

## Part B — 第三方 13 包子功能拆解

### B.0 先读：官方拆分机制速览（详见 Part C）

pi 官方（`docs/packages.md`）提供四种拆分/选装手段，**决定粒度的是包的 manifest 入口结构**：

| 机制 | 粒度 | 保留更新？ |
|---|---|---|
| ① settings.json **object-form 过滤** | manifest 声明的每个文件（extension 入口 / skill 目录 / prompt 文件 / theme 文件） | ✅ 包仍走 npm，`pi update --extensions` 照常 |
| ② **项目级安装**（`pi install -l`） | 整包，按项目（`.pi/settings.json`） | ✅ 同上 |
| ③ **包内配置开关**（各包自定义） | 到工具级（取决于包作者） | ✅ 同上 |
| ④ vendor / drop-in 单文件 | 文件级 | ❌ 需手动同步 |

**关键结论**：`"extensions": ["./index.ts"]` 单入口包（pi-subagents、pi-web-access、pi-research、pi-mcp-adapter、pi-bib、pi-critique）在 ① 层面**不可拆工具**——所有工具在同一个入口里注册。多入口/目录型包（pi-agent-extensions 17 入口、ars 的 prompts、所有包的 skills）可以 ① 拆。

### B.1 pi-subagents 0.65.0 — 子代理枢纽（单入口，工具不可拆）

- **入口结构**：`extensions: ["./index.ts"]`（+`skills` +`prompts`）。工具注册分散在 src/ 内部模块（src/extension/index.ts:773 等），由单一入口拉起
- **子功能清单**：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| `subagent` | 工具 | 编排枢纽：单代理派发、workflowScript 编排、schedule.create 定时、mission 持久任务、worktree 隔离、resume/steer | ❌ |
| `bg_wait` | 工具 | 等待后台运行/外部任务（src/runs/background/wait-tool.ts:42） | ❌ |
| `subagent_supervisor` | 工具 | 跨会话 supervisor 通道（src/intercom/native-supervisor-channel.ts:293） | ❌ |
| skills: pi-subagents / council-mode | skill | 使用指引 / 多顾问会议模式 | ✅ ① 可关 |
| prompts/ | prompt | 子代理相关模板 | ✅ ① 可关 |

- **行为配置**：config.json（maxSubagentSpawnsPerRun 等，docs/configuration.md）——是行为参数不是功能开关
- **拆分建议**：无需拆（roadmap 白名单保留项，全功能都有用）；若嫌 council-mode 或 prompts 冗余可 ① 关闭：
```json
{ "source": "npm:pi-subagents", "prompts": [], "skills": ["skills/pi-subagents", "!skills/council-mode"] }
```

### B.2 pi-web-access 0.27.0 — 搜索/抓取（单入口，但有官方工具级开关 ③）

- **入口结构**：`extensions: ["./index.ts"]`，内部 40+ provider/extractor 模块文件（brave.ts、bocha.ts、exa.ts、github-extract.ts、unpdf…）都是内部实现，非独立资源
- **子功能清单**（index.ts:154-157、240-247、1043 实测）：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| `web_search` | 工具 | 20+ 提供商 fallback 搜索链，多查询角度 | ✅ ③ `tools.webSearch.enabled` |
| `source_check` | 工具 | 带引用核验的事实检查 | ✅ ③ 跟随 webSearch 总开关 |
| `fetch_content` | 工具 | URL 抓取（GitHub 克隆/PDF/YouTube/视频帧，mode readable/raw/answer） | ✅ ③ `tools.fetchContent.enabled` |
| `get_search_content` | 工具 | 检索既往搜索结果的存储切片 | ❌（无条件注册） |
| /websearch /curator /search /google-account | 命令 | 搜索配置 UI / 浏览器策展 / 直搜 / 账号管理 | ✅ ③ `commands.<name>.enabled` |

- **开关位置**：`web-search.json`（`getWebSearchConfigPath()`，feature-config.ts:5）。示例——只留搜索关掉抓取：
```json
{ "tools": { "fetchContent": { "enabled": false } } }
```
- **拆分建议**：四个工具建议全保留（互不重复）；开关主要价值是**按项目/按阶段收窄模型可见工具**。

### B.3 @lincoln504/pi-research 1.6.10 — 深度研究 + 知识库（单入口，不可拆）

- **入口结构**：`extensions: ["./src/index.ts"]`；内部 20+ 子目录（knowledge/orchestration/web-research/youtube/stackexchange…）全是 research 运行时的内部组件，不是 pi 资源
- **子功能清单**（src/index.ts:322/326/336 注册点实测）：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| `research` | 工具 | 协调多 researcher 的深度研究（depth 1-3），本地隐身浏览器，免 API 配额 | ❌ |
| `research_knowledge_search` | 工具 | 本地知识库检索（Project+User 双库，instant 免费） | ❌ |
| `health` | 工具 | 浏览器池/知识库/GPU 锁状态 | ❌ |
| agent-skill/ | skill | 运行时自装的知识库使用指引 SKILL.md（src/skill-install） | ❌（非 manifest 资源） |

- **注意**：src/config.ts:182-186 的 `excludeTools` 是限制**研究员内部可用工具**，不是关闭上述三工具
- **拆分建议**：不可拆也无需拆；三工具是"先查库→不够再研究"层级的一体两面

### B.4 pi-mcp-adapter 2.32.1 — MCP 代理（单入口，按服务器天然拆分）

- **入口结构**：`extensions: ["./index.ts"]`（60+ 内部模块：direct-tools/namespace-tools/proxy-modes/oauth…）
- **子功能清单**：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| `mcp` | 工具 | MCP 网关：状态/搜索/describe/单调用/OAuth | ❌ |
| `mcpScript` | 工具 | JS 脚本批量编排 MCP 调用（loop/filter/chain） | ❌ |
| 服务器暴露 | — | 每个 mcp.json 服务器自动生成 `mcp__<server>` 命名空间工具 | ✅ **mcp.json 增删服务器即拆分** |

- **拆分维度**：MCP 服务器级（Zotero = `mcp.json` 一行配置）；工具粒度上 direct/namespace/proxy 三种代理模式（proxy-modes.ts）是配置级选择
- **拆分建议**：现状（仅 Zotero，eager）已是"最小可用"；加新 MCP 服务器 = 编辑 mcp.json，不涉及包本身

### B.5 pi-multiloop 0.4.0 — 循环引擎（目录入口但单逻辑，不可拆）

- **入口结构**：`extensions: ["./extensions"]` → extensions/pi-multiloop/（index.ts 主入口 + goal/lanes/loop/metrics/modes/state/tasks/ui/verifiers.ts 内部模块，互相 import）
- **子功能清单**：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| `multiloop_start/iterate/measure/decide/log/resume/pause/stop/archive` | 工具 ×9 | measured 循环全生命周期（optimize/research/dev/punchlist 四模式） | ❌ |
| `get_goal` / `update_goal` | 工具 ×2 | **quick goal**（轻量目标，非循环） | ❌（与工具同文件注册） |
| skills/multiloop | skill | 使用指引 | ✅ ① 可关 |

- **⚠️ 撞名警示**：`get_goal`/`update_goal` 与 harness Goal 模块工具**同名**（audit 文档 P3）。装 harness 前需实测两者共存行为；若冲突，可用 ① 关掉 pi-multiloop 的……**不行，无法按工具过滤**——这是"单入口不可拆"的实际代价，届时二选一：harness 不注册重复工具（改 harness 侧），或不用 multiloop quick goal
- **拆分建议**：全保留；quick-goal 与 harness Goal 的重叠待装 harness 后实测裁决

### B.6 pi-autoresearch 1.7.0 — 实验循环（skill 可拆）

- **入口结构**：`extensions: ["./extensions"]`（单逻辑扩展）+ `skills: ["./skills"]`（3 个独立 skill 目录）
- **子功能清单**：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| `init_experiment` / `run_experiment` / `log_experiment` | 工具 ×3 | 实验初始化/执行/记录（+ 实时仪表盘） | ❌ |
| `/autoresearch` | 命令 | 循环模式入口 | ❌ |
| skill: autoresearch-create | skill | 创建/启动实验循环 | ✅ ① |
| skill: autoresearch-finalize | skill | 收尾成可审查分支 | ✅ ① |
| skill: autoresearch-hooks | skill | 编写迭代前后 hook（通知/持久学习/防 thrash） | ✅ ① |

- **拆分建议**：三个 skill 是"入门/收尾/进阶"分层，若只用 multiloop 不用 autoresearch 可整包项目级化（② 装进实验项目，全局移除）

### B.7 pi-lifeline 0.1.3 — 求助强模型（单一功能，无可拆）

- **入口结构**：`extensions: ["./extensions/pi-lifeline"]`（index.ts + policy.ts）
- **子功能**：`phone_a_friend` 工具（index.ts:542）+ `/lifeline` 命令（index.ts:583）+ autoresearch 触发检测（连续 3 失败/6 平台期，限频策略）
- **拆分建议**：无。极小包，保留即可

### B.8 pi-bib 0.1.0 — BibTeX 质检（单一功能，无可拆）

- **入口结构**：`extensions: ["./src/index.ts"]`
- **子功能**：无工具；命令 `/review:bib`（src/index.ts:958）、`/review:bib:interactive`（src/index.ts:850）；CrossRef+S2 双源校验，输出 pi-bib-report.md + 建议文件
- **拆分建议**：无。与 harness `bibtex_check` 分工明确（元数据 vs 引用一致性）

### B.9 pi-critique 0.1.3 — 结构化批判（单一功能，无可拆）

- **入口结构**：`extensions: ["./index.ts"]`
- **子功能**：无工具；命令 `/critique`（index.ts:381）；C1/C2 编号批评 + academic lens
- **拆分建议**：无

### B.10 @portos-wang/academic-research-skills 0.11.0 — 学术全流程（prompt 级可拆 ✅）

- **入口结构**：`extensions: ["./extensions"]`（ars-hooks.ts 单文件）+ `skills: ["./skills"]`（当前为空）+ `prompts: ["./prompts"]`（**16 个 .md**）
- **子功能清单**：

| 子功能 | 类型 | 作用 | 独立开关 |
|---|---|---|---|
| ars-hooks.ts 自动路由 | extension | before_agent_start 关键词检测 → 自动注入对应 skill 路由指令（无需手动 /ars-*）+ Bucket A 写域守卫（ars-hooks.ts:1-20 头注） | ✅ ① `extensions: []` 关掉自动路由，保留手动命令 |
| 16 个 `/ars-*` prompt 命令 | prompt | ars-full（全流程）/ ars-lit-review / ars-abstract / ars-citation-check / ars-format-convert / ars-disclosure / ars-3w / ars-cache-invalidate 等（`ls prompts/` 实测 16 个） | ✅ ① **逐文件过滤** |

- **拆分示例**（只要文献综述+引用检查，关掉自动路由改手动触发）：
```json
{
  "source": "npm:@portos-wang/academic-research-skills-pi-extension",
  "extensions": [],
  "skills": [],
  "prompts": ["prompts/ars-lit-review.md", "prompts/ars-citation-check.md", "prompts/ars-full.md"]
}
```
- **提醒**：CC-BY-NC-4.0 许可，个人使用合规（roadmap §7.3 已确认）

### B.11 pi-agent-extensions 0.5.4 — 17 扩展大杂烩（**完全可拆** ✅✅）

- **入口结构**：**17 个独立入口文件** + 4 主题（package.json pi 字段实测）——官方 ① 过滤的理想对象
- **子功能全景**（extensions/ 目录 + README 实测）：

| # | 扩展 | 提供物 | 作用 | 当前是否在用（本会话证据） |
|---|---|---|---|---|
| 1 | ask-user | `ask_user` 工具 | 结构化提问（Beta） | ✅ 在用（harness Ask 的补位竞争者） |
| 2 | todos | `todo` 工具 + `/todos` | 文件任务 + claim/release | ✅ 在用 |
| 3 | workflow | `workflow` 工具 + `/workflow` | agent/parallel/pipeline 编排（模型路由/并发/审批） | ✅ 在用 |
| 4 | loop | `signal_loop_success` 工具 | 循环突破信号 | ✅ 在用 |
| 5 | sessions | `/sessions` | 项目会话搜索 + 实时预览 | ？ |
| 6 | handoff | `/handoff` | 会话交接提示提取 | ？ |
| 7 | notify | 通知 | 桌面/自定义通知 | ？ |
| 8 | context | 上下文管理 | 上下文注入/裁剪 | ？ |
| 9 | files | `/files` | 模糊导航 + Git 状态 + diff | ？ |
| 10 | review | `/review` | 交互式代码审查流 | ？ |
| 11 | answer | `/answer` | 批量收集多问题答案 | ？ |
| 12 | control | 运行控制 | 会话控制 | ？ |
| 13 | cwd-history | 目录历史 | cwd 切换历史 | ？ |
| 14 | session-breakdown | 会话分析 | 使用统计分解 | ？ |
| 15 | btw | `/btw` | 旁问不污染历史 | ？ |
| 16 | whimsical | 趣味 | 彩蛋类 | 大概率不用 |
| 17 | powerline-footer | 状态栏 | powerline 信息栏 | ？ |
| + | 4 主题 | themes | nightowl / p10k / ghostty-dark / fzf-bat | 当前用 dark 主题（settings.json），未用其主题 |

- **拆分示例**（只留 4 个在用扩展，去掉主题）：
```json
{
  "source": "npm:pi-agent-extensions",
  "extensions": [
    "extensions/ask-user/index.ts",
    "extensions/todos/index.ts",
    "extensions/workflow/index.ts",
    "extensions/loop/index.ts"
  ],
  "themes": []
}
```
- **与 harness 的关系**：装 harness 后 ask-user/todos 与 `ask_user_question`/`todo_list` 双轨——届时应从此过滤中删掉 ask-user 和 todos
- **追溯**：过滤配置独立于包版本，`pi update` 照常；**风险**：上游改入口路径会使过滤静默失效（该扩展消失）——更新后跑 `pi list` + 工具清单 diff 检查

### B.12 pi-focus-bell 0.1.0 — 响铃（单文件，官方 vendor 案例）

- **入口结构**：`extensions: ["./focus-bell.ts"]`（123 行单文件）
- **子功能**：agent_end 时 BEL 响铃；tmux 焦点感知；`PI_BELL_ALWAYS`/`PI_BELL_DEBUG`
- **拆分建议**：无需拆。README 官方支持 drop-in 单文件（vendor 模式的先例），但 npm 安装 + 自动更新更省心

### B.13 superpowers-zh 1.7.11 — 方法论技能层（skill 级可拆 ✅）

- **入口结构**：`skills: ["./skills"]`（20 个独立 skill 目录）+ 1 个扩展（.pi/extensions/superpowers.ts：resources_discover 暴露 skills + session_start 注入 using-superpowers 引导，superpowers.ts:18-30）
- **20 个 skill 清单**（ls skills/ 实测）：

| 类别 | skill | 说明 |
|---|---|---|
| 流程核心 | brainstorming / writing-plans / executing-plans | 创造前探索 / 写计划 / 执行计划 |
| 工程纪律 | test-driven-development / systematic-debugging / verification-before-completion | TDD / 系统化调试 / 完成前验证 |
| 审查协作 | requesting-code-review / receiving-code-review / dispatching-parallel-agents / subagent-driven-development | 发起/接收审查 / 并行派发 / 子代理驱动开发 |
| Git | using-git-worktrees / finishing-a-development-branch | worktree 隔离 / 分支收尾 |
| 元技能 | using-superpowers / writing-skills | 技能发现 / 写技能 |
| 工具方法论 | mcp-builder / workflow-runner | 构建 MCP / 运行 YAML 工作流 |
| 中文场景 ×4 | chinese-code-review / chinese-commit-conventions / chinese-documentation / chinese-git-workflow | 仅显式 /命令 触发 |

- **拆分建议**：20 个都有明确场景；若精简，中文 ×4 和 workflow-runner 是最可能闲置的：
```json
{ "source": "npm:superpowers-zh", "skills": ["skills/*", "!skills/chinese-*", "!skills/workflow-runner"] }
```
- **注意**：关掉 extensions（superpowers.ts）会失去 using-superpowers 自动引导注入，但 skills 本体仍可用

---

## Part C — 拆分与追溯的机制详解

### C.1 官方 object-form 过滤（首选手段）

settings.json `packages` 数组支持字符串或对象混排（packages.md "Package Filtering" 节）：

```json
{
  "packages": [
    "npm:pi-lifeline",
    {
      "source": "npm:pi-agent-extensions",
      "extensions": ["extensions/ask-user/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "themes": ["+themes/nightowl.json"]
    }
  ]
}
```

- 省略键 = 该类型全载；`[]` = 全不载；`!pattern` 排除；`+path` 强制包含；`-path` 强制排除
- **过滤叠加在 manifest 之上，只能收窄不能扩宽**
- 路径相对包根（对 17 入口的 pie 是 `extensions/<name>/index.ts`；对 prompt 是 `prompts/<name>.md`）

### C.2 更新追溯的保证与风险

| 手段 | 更新行为 | 追溯评级 |
|---|---|---|
| ① 过滤（全局） | `pi update --extensions` / `--all` 正常更新 npm 包；过滤配置不动 | ⭐⭐⭐⭐⭐ |
| ② 项目级安装（`pi install -l` → `.pi/settings.json`） | 同上，按项目独立 | ⭐⭐⭐⭐⭐（学术包装进论文项目是最佳实践） |
| npm 版本 pin（`npm:pkg@1.2.3`） | **被 update 跳过** | ⭐⭐⭐（明确冻结） |
| git ref pin（`git:repo@v1`） | update 只 reconcile 到 pinned ref，不前进 | ⭐⭐⭐（同上，需手动换 ref） |
| ③ 包内配置开关 | 随包更新，配置文件独立 | ⭐⭐⭐⭐⭐ |
| ④ vendor 单文件 | 无更新，靠手动 diff 同步 | ⭐（最后手段；focus-bell 式微件可接受） |

**① 的唯一风险**：上游重命名/移动入口文件 → glob 匹配不到 → 功能**静默消失**。缓解纪律：每次 `pi update` 后对比工具/skill 清单（`pi list` 或新会话 available_tools diff）。

### C.3 高级用法：项目级 delta

同一包全局+项目都装时，项目条目覆盖全局；**`autoload: false` 使项目条目变成叠加在全局上的增量**（packages.md "Scope and Deduplication"）——例如全局装 pie 17 扩展，某项目只想留 3 个：

```json
// .pi/settings.json
{ "packages": [ { "source": "npm:pi-agent-extensions", "autoload": false,
    "extensions": ["extensions/files/index.ts", "extensions/review/index.ts"] } ] }
```

### C.4 临时试用与卸载

- `pi -e npm:pkg` 临时目录加载，不落盘（试用新包标准姿势）
- `pi remove` / 从 packages 数组删除

---

## Part D — 个人局部层 → `personal/` 子包（已完成 ✅）

原散落两处的个人局部能力已收录为独立可选装 pi package（**与主 harness 无依赖，分开装**）：

```
personal/
├── package.json          # name: pi-lamboy-personal（pi manifest: extensions + skills）
├── README.md             # 选装/迁移/配置/卸载全说明
├── extensions/
│   └── image2.ts         # generate_image 工具（京东云 gpt-image2，354 行，头部已加收录标注）
└── skills/
    └── joyspace-md-import/
        ├── SKILL.md      # JoySpace Slate 编辑器写入流程（187 行）
        ├── references/slate-schema.md
        └── scripts/      # import.js + svg2png.js + package.json（node_modules 未收录，README 有安装指引）
```

- **选装**：`pi install /Users/liulian.leliy/github-projects/pi-lamboy-harness/personal`（local-path，settings 记录路径不复制，仓库即生效源）
- **防双注册**：安装前先 `mv` 掉 `~/.pi/agent/extensions/image2.ts` 与 `~/.pi/agent/skills/joyspace-md-import`（README 有完整步骤）
- **Zotero MCP 不迁移**：它由 `mcp.json` 管理（独立于包系统），保持现状

---

## Part E — 待决策清单（勾选后执行）

| # | 决策项 | 选项 | 建议 |
|---|---|---|---|
| E1 | pie 17 扩展留哪些？ | 见 B.11 表（1–4 在用已证实，5–17 待你确认使用频率） | 先过滤到在用项；装 harness 后再删 ask-user/todos |
| E2 | ars 16 个 prompt 留哪些？ | 见 B.10（可逐文件） | 论文项目用 ② 项目级安装，全局可整包移除 |
| E3 | superpowers 20 skill 留哪些？ | 中文 ×4 / workflow-runner 是否常 用 | 默认全留；闲置者 `!` 排除 |
| E4 | pi-web-access 四工具全留？ | B.2 开关示例 | 全留 |
| E5 | 学术三包（bib/critique/ars）全局 vs 项目级？ | ① 全局过滤 / ② 论文项目装 | ② 项目级（学术工具只在写作项目出现，日常仓库零噪声） |
| E6 | harness 何时安装？ | audit P1 | 先装后过滤 pie（顺序不可反：先有补位再裁撤） |
| E7 | pi-lens 是否新增？ | audit §5.2 | 场景 3 高频后装 |

---

## 证据附录

- **Part A**：packages/core/pause/gate.ts（全文 140 行）、pause/screen.ts（123 行）、pause/commands.ts（22 行）、packages/core/pause/lines.ts（头 50 行）、tui/index.ts（366 行全文）、tui/editor.ts（126 行全文）、packages/core/truncation/index.ts（69 行全文）、CHANGELOG 0.9.19/0.9.21、tests/{pause-gate,truncation,tui*,shimmer}.test.mjs（21 套件中相关 5 个）
- **Part B**：各包 `package.json` pi manifest（2026-09-06 实测）；pi-web-access index.ts:154-157/240-247/1043、feature-config.ts:5-28；pi-research src/index.ts:322-336、src/config.ts:182-186；pi-subagents src/extension/index.ts:773、src/intercom/native-supervisor-channel.ts:293、src/runs/background/wait-tool.ts:42；pi-lifeline index.ts:542/583；pi-bib src/index.ts:850/958；pi-critique index.ts:381；ars extensions/ars-hooks.ts:1-40、`ls prompts/`=16；pi-agent-extensions package.json（17 入口）；superpowers-zh .pi/extensions/superpowers.ts:18-30
- **Part C**：pi 官方文档 `docs/packages.md`（Install and Manage / Package Filtering / Enable and Disable Resources / Scope and Deduplication 四节，228 行）
- **Part D**：personal/ 目录实物 + README.md
