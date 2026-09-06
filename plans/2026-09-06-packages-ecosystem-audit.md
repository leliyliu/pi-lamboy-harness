# Pi 生态包全景审计（2026-09-06）

> 目的：盘点个人 pi 生态中**所有包**（自建 + 第三方 + 局部扩展），说明各自能力与用法，为"新增 or 精简"决策提供事实基础。
> 证据基准：`~/.pi/agent/settings.json`（13 包实测）、`~/.pi/agent/npm/node_modules/`、本仓库 v0.13.0 源码、本会话实际可用工具清单。
> 前置文档：`plans/personal-harness-roadmap.md`（v0.3，2026-08-14，Phase 0–4 已执行）。

---

## 0. 三层生态总览

```
个人 pi 生态（2026-09-06 实测）
│
├── 第一层：自建 harness —— pi-lamboy-harness v0.13.0（本仓库）
│   ⚠️ 未安装到当前环境（settings.json 包列表无记录，~/.pi/agent/ 无安装痕迹）
│   10 模块：Goal / Plan / Permission / Ask / Todo / Pause / TUI / Truncation / perf-lab / latex
│
├── 第二层：白名单第三方 13 包（settings.json packages[] 实测）
│   编排执行：pi-subagents、pi-multiloop、pi-autoresearch、pi-lifeline
│   信息获取：pi-web-access、@lincoln504/pi-research、pi-mcp-adapter（+ Zotero MCP）
│   学术场景：pi-bib、pi-critique、@portos-wang/academic-research-skills
│   其他：superpowers-zh（方法论）、pi-agent-extensions（17 扩展）、pi-focus-bell（响铃）
│
└── 第三层：个人局部扩展与 skill
    ~/.pi/agent/extensions/image2.ts     → generate_image 工具（京东云 gpt-image2）
    ~/.pi/agent/skills/joyspace-md-import → JoySpace 文档导入 skill
```

**当前会话工具归因速查**（本会话系统提示实测，与包源码核对）：

| 会话中的工具/能力 | 来源 | 证据 |
|---|---|---|
| read / write / edit / bash / send_to_session / list_sessions | pi 原生 | pi 内建 |
| `subagent` / `bg_wait` / `subagent_supervisor` | pi-subagents | 系统提示 + 包说明 |
| `multiloop_start` 等 9 工具 + `get_goal`/`update_goal`（quick goal） | pi-multiloop | 系统提示（quick goal 描述） |
| `web_search` / `source_check` / `fetch_content` / `get_search_content` | pi-web-access | 系统提示 |
| `research` / `research_knowledge_search` / `health` | @lincoln504/pi-research | `src/tools/health-tool-definition.ts` |
| `phone_a_friend` | pi-lifeline | 包 README |
| `mcp` / `mcpScript` / `mcp__zotero` | pi-mcp-adapter + Zotero MCP | mcp.json（127.0.0.1:23120） |
| `ask_user` | pi-agent-extensions (ask-user) | extensions/ask-user/index.ts:7 |
| `todo`（.pi/todos, claim/release） | pi-agent-extensions (todos) | extensions/todos/index.ts:1428 |
| `workflow`（agent/parallel/pipeline/phase/gate/checkpoint） | pi-agent-extensions (workflow) | 系统提示全局函数表 + README model-routes |
| `signal_loop_success` | pi-agent-extensions (loop) | extensions/loop/index.ts（grep 实测） |
| `generate_image` | **个人扩展** image2.ts | ~/.pi/agent/extensions/image2.ts（12.7KB） |
| 28 个可用 skills | superpowers-zh(20) + pi-subagents(2) + pi-autoresearch(3) + joyspace(1) | available_skills 清单 |

---

## 1. 第一层：本仓库 pi-lamboy-harness v0.13.0

**定位**：个人差异化核心——把 pi 刻意不做的编排能力（目标/计划/守卫/面板）做成单一安装包；子代理/搜索/MCP 交给白名单第三方（README 第 7–8 行）。
**架构**：core/adapter 分层。`packages/core/` 零 pi import 纯逻辑；仓库根是 pi 适配层（index.ts:1–33 import 实测）。
**质量**：21 套件 / 631 断言，node 级无需模型配额（README Tests 节）。

### 1.1 模块详解（10 个）

| # | 模块 | 注册的工具 | 命令 | 何时用（典型场景） | 代码位置 |
|---|---|---|---|---|---|
| 1 | **Goal** | `create_goal` `get_goal` `update_goal` `set_goal_budget` | `/goal` | 长任务开局：设目标 + 三重预算（token/turn/wall-clock），blocked 3 轮阈值防误判，FIFO+优先级队列管理多目标，compaction 后自动恢复 | packages/core/goal/（8 文件，状态机+预算+队列+持久化） |
| 2 | **Plan** | `enter_plan_mode` `exit_plan_mode` | `/plan` | 大仓库改动前：只读探索 → 写计划 → 审批 → 执行；Write/Edit 拦截（plan 文件除外），plan 注入 system prompt | packages/core/plan/ |
| 3 | **Permission** | （策略层） | `/mode` | auto/yolo/manual 三模式 + 守卫层：`rm -rf`/`git push --force` 等破坏性命令必问，`.env`/`id_rsa` 敏感文件永远拦，会话指纹记忆批准不蜕变为永久许可 | packages/core/permission/（policies/config/approval-rpc） |
| 4 | **Ask** | `ask_user_question` | — | 需要用户决策时：1–4 个问题页签对话框，多选 + 选项级 Markdown 预览 + "Chat about this" 出口；auto 模式下被拒（防无人值守卡死） | ask/index.ts + ask/dialog.ts（696 行对话框） |
| 5 | **Todo** | `todo_list` | `/todo`（init/start/done/drop/export/import/copy/edit/toggle…） | 分阶段任务：罗马数字阶段树内联面板，done 自动淡出，agent 停下时未完成项以 `<system-reminder>` 注入（最多 3 次防抖），claim/release 多会话协作 | todo/index.ts（536 行）+ packages/core/todo/ |
| 6 | **Pause** | — | `/pause` | 长时间运行中临时冻结：agent 在下一个工具边界停车（不中止），全屏遮罩 + 计时，esc/enter/space/ctrl+c 恢复 | pause/commands.ts + screen.ts + core/pause/ |
| 7 | **TUI** | — | `/tui`（style/shimmer/timing） | 日常体验：闭合框编辑器（plain/boxed/compact）、边框 spinner + 工作状态、shimmer 扫光动画、plan 徽标 | tui/（editor+index 492 行）+ core/tui/（8 文件） |
| 8 | **Truncation** | — | （自动生效） | 大输出场景：超阈值工具结果落盘 `<sessionDir>/tool-results/`，上下文只留头尾预览 + 分页说明；阈值随模型窗口缩放（max(40k, 窗口×4)，上限 800k 字符） | packages/core/truncation/ |
| 9 | **perf-lab** | `bench_run` `profile_parse` `metric_compare` | — | 场景 1/2 测量侧：ssh 远程 GPU 基准（N 轮 + MAD 离群剔除 + P50/P95 + nvidia-smi 快照）、torch profiler trace → 热点表、Mann-Whitney 显著性 → improve/regress/noise；结果落 `.perf/<run-id>.json` 供 pi-multiloop verify 消费 | perf/index.ts（297 行）+ core/perf/ |
| 10 | **latex** | `latex_compile` `bibtex_check` | `/compile [file]` | 论文写作：tectonic 编译 → 结构化 `file:line` 错误 + 修复提示（vs 读原始日志）；`.tex` 引用与 `.bib` 交叉比对（未定义引用/未用条目/重复 key；元数据校验归 pi-bib） | latex/index.ts（262 行）+ core/latex/ |

### 1.2 仓库状态

- 版本 0.13.0（CHANGELOG 顶项：Phase 4 latex 落地，2026-08-14）
- Roadmap Phase 0–4 **全部执行完毕**；遗留：真实 GPU 验收（kunshan-quant）pending、explore-sync（§6.3）未开工
- devDeps 锁 pi 0.84.2；CI 三平台 × Node 22/24/26

### 1.3 ⚠️ 关键发现：harness 未安装到当前环境

**证据**：
- `~/.pi/agent/settings.json` 的 `packages` 数组（13 项）无 pi-lamboy-harness
- `~/.pi/agent/extensions/` 仅有 image2.ts
- 当前会话工具清单中无 `create_goal` / `enter_plan_mode` / `ask_user_question` / `todo_list` / `bench_run` / `latex_compile` / `bibtex_check`，无 `/goal` `/plan` `/pause` `/tui` `/compile` 命令

**含义**：Phase 2 的"Ask/Todo 补位 pi-agent-extensions"设计**从未实际生效**——当前会话在用的 `ask_user` / `todo` / `workflow` / `signal_loop_success` 全部来自 pi-agent-extensions（§2.12）。roadmap 批准的"`pi remove npm:pi-agent-extensions`"也未执行。

**行动项**：`pi install git:github.com/leliyliu/pi-lamboy-harness`（或 `pi install /Users/liulian.leliy/github-projects/pi-lamboy-harness` 本地直装）→ 验证补位 → 再决定 pi-agent-extensions 去留。

---

## 2. 第二层：白名单第三方 13 包逐一详解

### 2.1 pi-subagents —— 子代理基础设施枢纽 ✅ 保留（roadmap §5.3）

- **提供**：`subagent` 工具（单代理 / workflowScript 编排 / `schedule.create` 定时 / mission 持久任务 / worktree 隔离 / resume 续跑 / steer 转向 / async 后台）、`bg_wait`、`subagent_supervisor`（跨会话协作）、2 个 skill（pi-subagents、council-mode）
- **用法**：并行审查 / 多 lane 改造 / 定时任务 / 派生子会话跑长任务；本会话系统提示对它的调用纪律有详细规定（workflowScript 约束、runs.all 语义）
- **与其他的关系**：harness 已删 Swarm/Cron 就是为了让位给它（roadmap §2.1/§2.5）

### 2.2 pi-web-access —— 搜索/抓取基础设施 ✅ 保留

- **提供**：`web_search`（20+ 提供商 fallback 链，支持多查询角度）、`source_check`（带引用核验的结构化事实检查）、`fetch_content`（GitHub 仓库/PDF/YouTube/视频帧/网页）、`get_search_content`（检索已存内容切片）
- **用法**：一切需要互联网信息的任务；系统提示已配置"research 类问题优先 knowledge store → research 工具"的层级，web_search 是其中一环

### 2.3 @lincoln504/pi-research —— 免费深度研究 + 知识库 ✅ 保留（独有）

- **提供**：`research`（本地隐身浏览器协调多 researcher 的深度研究，depth 1–3）、`research_knowledge_search`（本地知识库即时检索，覆盖 Project+User 两库）、`health`（浏览器池/知识库/GPU 锁状态）
- **用法**：所有 web 研究问题**先查知识库**（instant、免费），空/部分命中才上 `research`；研究成果沉淀进知识库后可跨会话复用
- **注意**：系统提示规定 research 工具自带内部并行化，**禁止**用 subagent 手动并行 research

### 2.4 pi-mcp-adapter —— MCP 省上下文代理 ✅ 保留

- **提供**：`mcp`（网关：状态/搜索/describe/单调用）、`mcpScript`（JS 批量编排多次 MCP 调用）、`mcp__zotero`（命名空间直连）
- **用法**：Zotero 文献库交互（mcp.json 配置 `http://127.0.0.1:23120/mcp`，eager 生命周期）；~200 token/服务器的按需发现模式省上下文

### 2.5 pi-multiloop —— 测量驱动的循环引擎 ✅ 保留（场景 1/2 核心）

- **提供**：`multiloop_start/iterate/measure/decide/log/resume/pause/stop/archive` 9 工具 + **quick goal**（`get_goal`/`update_goal`，即当前会话所见）+ multiloop skill
- **四种模式**：optimize（metric 改进 keep/revert）/ research / dev / punchlist；多 lane、复合验证器、MAD 噪声置信度、JSONL 持久史
- **用法**：`/goal` 设 quick goal（轻量），或 `multiloop_start` 起 measured 循环（配 verifyCommand 产出 metric）；与 harness perf-lab 通过 `.perf/<run-id>.json` 松耦合（bench_run 产数 → multiloop verify 消费）

### 2.6 pi-autoresearch —— 自主实验循环 ✅ 保留

- **提供**：3 个 skill（autoresearch-create/finalize/hooks）+ 实验循环工具（init/run/log_experiment）+ `/autoresearch` 命令 + 实时仪表盘
- **用法**："帮我循环优化 X"类任务的入口；与 pi-lifeline 联动（卡住时触发求助）

### 2.7 pi-lifeline —— 卡住求助强模型 ✅ 保留

- **提供**：`phone_a_friend` 工具 + `/lifeline` 命令；自动监听 autoresearch 实验结果，连续 3 次失败或 6 轮平台期才触发（限频，默认 nudge 而非自动花钱）
- **用法**：长时无人值守循环的安全网；系统提示强调"偶尔用，不要每轮都调"

### 2.8 superpowers-zh —— 方法论技能层（20 skills）✅ 保留

- **提供**：流程技能（brainstorming / TDD / systematic-debugging / writing-plans / executing-plans / requesting+receiving-code-review / verification-before-completion / using-git-worktrees / dispatching-parallel-agents / subagent-driven-development / finishing-a-development-branch / writing-skills / mcp-builder / workflow-runner / using-superpowers）+ 4 个中文场景技能（chinese-code-review / commit-conventions / documentation / git-workflow）
- **用法**：所有任务的流程纪律层——本会话系统提示强制"技能优先"：构建前 brainstorming、修 bug 前 systematic-debugging、宣称完成前 verification-before-completion；中文技能仅在显式 /命令 时触发

### 2.9 pi-bib —— BibTeX 质检 ✅ 保留（2026-08-14 试用通过）

- **提供**：BibTeX/参考文献校验扩展（CrossRef + Semantic Scholar 双源，DOI 优先）；输出 `pi-bib-report.md` + `pi-bib-suggested/` 建议文件，`updated`/`needs_review`/`not_found` 三态
- **用法**：论文投稿前跑一次全库校验；系统提示已注入"怀疑型引用审查者"指引（本会话生效中）
- **分工**：元数据正确性归 pi-bib；`.tex`↔`.bib` 引用一致性归 harness bibtex_check

### 2.10 pi-critique —— 结构化批判 ✅ 保留（试用通过）

- **提供**：编号式批评（C1/C2…）+ 行内标记 + academic lens（methodology/citation/logic/scope）；非破坏性，pairs with markdown-preview
- **用法**：论文/代码的深度评审与润色前批判

### 2.11 @portos-wang/academic-research-skills —— 学术全流程 ✅ 保留（试用通过，CC-BY-NC 个人使用）

- **提供**：4 skill + 27 模式 + 39-agent 集群（Deep Research 13-agent/PRISMA、Paper 12-agent、Reviewer 7-agent、Pipeline 10-stage）+ `ars-*` 命令族 + prompts（ars-full/ars-lit-review/ars-abstract/ars-citation-check/ars-format-convert/ars-disclosure/ars-3w/ars-cache-invalidate 等）
- **用法**：场景 4 全流程骨架：research → write → review → revise → finalize
- **许可注意**：CC-BY-NC-4.0，仅个人使用不分发（roadmap §7.3 风险表）

### 2.12 pi-agent-extensions —— 17 扩展大杂烩 ⚠️ 决策已定"排除"，未执行

- **提供**（package.json pi.extensions 实测 17 项）：sessions（会话搜索/预览）、ask-user（`ask_user` 工具）、handoff（`/handoff` 交接提示提取）、notify、context、files（`/files` 模糊导航+Git 状态）、review（`/review` 交互式审查）、loop（`signal_loop_success`）、answer（`/answer` 批量作答）、control、cwd-history、session-breakdown（会话分析）、todos（`todo` 工具 + `/todos`）、whimsical、btw（`/btw` 旁问不污染历史）、powerline-footer、workflow（`workflow` 工具，agent/parallel/pipeline/phase/gate/checkpoint/budget API）+ 4 主题
- **当前实际占用**：本会话 4 个工具（ask_user / todo / workflow / signal_loop_success）由它提供
- **roadmap 决策**（2026-08-14 批准）：排除，ask_user/todo 由 harness Ask/Todo 补位（质量占优：123/117 断言 vs Beta 状态）；sessions/handoff/review 等视淘汰后使用痛感逐项评估（§6.4）
- **⚠️ 现实**：既没排除，harness 也没装——双轨设计的补位端缺席，pie 反而是唯一在岗者

### 2.13 pi-focus-bell —— 终端响铃 ✅ 新增（roadmap 之后）

- **提供**：无工具/命令。`agent_end` 时发 BEL；tmux 感知（当前 pane 在看则不响）；`PI_BELL_ALWAYS` / `PI_BELL_DEBUG` 环境变量
- **用法**：挂后台跑长任务，空闲时被铃声拉回；需要 tmux `bell-action any` + `visual-bell off` + 终端音频配置配合
- **定位**：长时无人值守场景的注意力层，与 pi-lifeline（策略层）互补

---

## 3. 第三层：个人局部扩展与 skill

| 项 | 位置 | 提供能力 | 用法 |
|---|---|---|---|
| **image2.ts** | `~/.pi/agent/extensions/image2.ts`（12.7KB，2026-08-20） | `generate_image` 工具：京东云 gpt-image2 文生图，1–4 张/次，1024²/1024×1536/1536×1024/auto | 任何"画一张图/生成示意图"需求；系统提示已强制"要求画图必须调用此工具" |
| **joyspace-md-import** | `~/.pi/agent/skills/` |JoySpace（joyspace.jd.com）在线文档写入：Slate 编辑器自动化、SSO 登录、图片上传、协作写入 | 把 markdown 报告（含本地图片/表格/代码块）发布到京东 JoySpace |
| **Zotero MCP** | `mcp.json`（本地 23120 端口） | 20 个文献库工具（经 pi-mcp-adapter 代理） | 场景 4 文献检索/管理 |

---

## 4. 问题清单：现状 vs 设计的偏差

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| P1 | **harness 未安装**——10 模块 0 生效 | §1.3 三重证据 | Goal/Plan/Permission 守卫/Pause/Truncation/perf/latex 全不可用；四大场景的核心底座缺席 |
| P2 | **pi-agent-extensions 排除决策未执行** | settings.json 第 12 项 vs roadmap §5.3 | ask_user/todo 双轨（pie 在岗、harness 缺席）；workflow(loop) 与 pi-subagents/pi-multiloop 三套编排语义并存，模型选择成本高 |
| P3 | **Goal 工具撞名风险**：harness `get_goal`/`update_goal` vs pi-multiloop quick goal 同名 | 两包工具定义实测 | 安装 harness 后同名工具的注册顺序/覆盖行为待验证（可能一个失效或语义混淆） |
| P4 | **roadmap 遗留项**：explore-sync 未开工；perf-lab 真实 GPU 验收 pending；pi-lens 未装 | roadmap §6.3/§7.2 Phase 3/§5.5 | 场景 1/2 的"实验→知识沉淀"链路断在最后一环 |
| P5 | 搜索三轨并存（web_search / research / knowledge store） | 系统提示已建层级规则 | 规则已解决优先级，非问题，但新增包时注意别引入第四轨 |

---

## 5. 精简 / 新增选项（供决策）

### 5.1 精简候选

**候选 S1：执行既定决策——装 harness、排除 pi-agent-extensions**（roadmap 原路线）

```
pi install git:github.com/leliyliu/pi-lamboy-harness   # 或本地路径直装
# 验证：ask_user_question/todo_list/goal/plan/pause/tui 补位无感
# 验证：Goal 工具撞名（P3）的实际行为
pi remove npm:pi-agent-extensions
# 淘汰痛感观察期：sessions/handoff/files/review/btw/answer 若高频使用再单独移植（roadmap §6.4）
```
- 收益：消除双轨；上下文工具表缩短；Ask/Todo 升级到高测试密度版本
- 风险：pie 的 workflow/sessions/files/review/btw 等 13 个 harness 不提供的扩展一起消失——需先确认实际使用频率（session 日志可查）

**候选 S2：渐进式——先装 harness 观察，pie 暂留**
- 收益：零破坏；可逐项对比 ask_user vs ask_user_question、todo vs todo_list 的体验
- 成本：双轨继续存在，模型工具选择成本不减

**候选 S3：不装 harness，承认 pie 路线**（推翻 roadmap）
- 收益：零动作
- 成本：放弃自建核心的 8,604 行高测试密度代码 + perf/latex 两个自建模块；Permission 守卫层（破坏性命令/敏感文件）无替代——**不推荐**（roadmap §2.7 论证过守卫层的不可替代性）

### 5.2 新增候选

| 候选 | 内容 | 依据 | 优先级 |
|---|---|---|---|
| N1 | **pi-lens**（lint/format/typecheck/结构分析直达 agent） | roadmap §5.5 ⭐⭐⭐⭐；与 Permission 形成"守卫+反馈"闭环 | 场景 3 高频后装 |
| N2 | **explore-sync 自建**（实验历史蒸馏 → pi-research 知识库） | roadmap §6.3，~300 行；打通场景 1/2 沉淀闭环 | 中 |
| N3 | harness Goal ↔ multiloop lane 适配器 | roadmap §4 #1"可选演进"（Goal 定目标/预算，multiloop 执行） | 低（先解决 P3） |

### 5.3 待用户决策的问题

1. **是否现在安装 harness 到当前环境？**（P1 是所有后续讨论的前提——不装则"精简 pie"无从谈起）
2. **pie 的 17 扩展中，sessions/files/review/btw/answer/handoff/notify/context 你实际在用哪些？**（决定 S1 的执行粒度）
3. **四大场景近期的主次？**（决定 N1/N2/N3 的排序）

---

## 6. 四大场景快速适配矩阵（装好 harness 后）

| 场景 | 开局动作 | 引擎 | 底座（harness） | 支撑 |
|---|---|---|---|---|
| **1 开放式技术探索** | `/goal` + `set_goal_budget` | multiloop (research/optimize) + autoresearch | Truncation（大输出）+ Pause | perf-lab 产数 → `.perf/` → verify；lifeline 卡住求助；focus-bell 拉回 |
| **2 算子级优化** | `/goal` + 预算 | multiloop (optimize) | Truncation | bench_run/profile_parse/metric_compare 闭环；lifeline |
| **3 大仓库维护** | `/plan`（只读探索→审批） | pi-subagents（worktree 隔离并行） | Permission 守卫 + Ask + Todo + Plan | superpowers-zh 方法论；pi-lens（待装）反馈 |
| **4 论文写作** | ars-* 全流程 | academic-research-skills 39-agent | latex（编译纠错） | pi-bib + bibtex_check 双检；pi-critique 批判；Zotero MCP；joyspace 发布 |

**通用纪律层**（所有场景）：superpowers-zh 流程技能（brainstorming→plans→TDD→verification）+ AGENTS.md 证据要求。

---

## 7. 证据附录

- settings.json 13 包清单：`~/.pi/agent/settings.json`（2026-09-06 读取）
- harness 未安装：settings.json 无记录 + `~/.pi/agent/extensions/` 仅 image2.ts + 会话工具清单缺 harness 全部 9 工具
- pie 工具注册：`node_modules/pi-agent-extensions/extensions/{ask-user:7, todos:1428}/index.ts`、`extensions/loop/index.ts`（signal_loop_success grep）
- health 归因：`@lincoln504/pi-research/src/tools/health-tool-definition.ts`
- 模块/测试数据：本仓库 README.zh-CN.md + `tests/`（21 套件）+ CHANGELOG.md 0.10–0.13
- roadmap 决策与依据：`plans/personal-harness-roadmap.md` v0.3（决策记录表 12 项全批准/执行）
- 当前会话工具/技能清单：本会话系统提示（2026-09-06）
