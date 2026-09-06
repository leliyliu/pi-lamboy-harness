# pi-lamboy-harness

**个人专属 Pi 编排底座** — Goal（目标生命周期/预算/队列）· Plan（计划门控）· Permission（危险操作守卫）· Ask（结构化提问）· Todo（阶段任务）· Pause（冻结检查）· TUI · Truncation（大输出溢出）· Perf（基准/剖析）· Latex（编译/引用）。

Fork 自 [MuseLinn/pi-muselinn-harness](https://github.com/MuseLinn/pi-muselinn-harness) 0.9.22（感谢原作者）。
个人改造路线：`plans/personal-harness-roadmap.md`；生态审计与最小集决策：`plans/2026-09-06-*.md`。
子代理/定时任务/搜索/MCP 由白名单第三方包提供（pi-subagents、pi-web-access、pi-mcp-adapter 等），本包只维护差异化核心。

**v0.14.0 起每个模块都是独立的扩展入口**（`extensions/10-pause.ts` … `95-latex.ts`）——可以用 settings.json 的 object-form 过滤按需启用任意子集，与第三方包使用同一套官方拆分机制；`presets/` 目录把启用面版本化，支持最小集/全量一键切换。

## 快速开始

```bash
# 全量安装（10 模块全部加载）
pi install git:github.com/leliyliu/pi-lamboy-harness   # 或: pi install /path/to/pi-lamboy-harness

# 或最小集安装（过滤到 8 模块：perf/latex 不加载）
# 手动在 settings.json 写入 object-form 条目，或直接用预设切换（见下）

# 个人附加能力（京东云生图 + JoySpace 导入，可选装）
pi install /path/to/pi-lamboy-harness/personal

pi                                                      # 重启 pi，然后试试：
```

体验一下：

```
/goal Refactor the auth module           # 设置目标，跟踪预算
/todo init "Phase 1: scanner"            # 开始分阶段任务计划
/plan                                    # 进入计划模式（只读探索）
/pause                                   # 冻结；esc/enter/space/ctrl+c 恢复
/tui style plain|boxed|compact           # 随时切换编辑器样式
```

所有工具模型可直接调用，所有命令均为支持 Tab 补全的 slash 命令。

## 功能

> **模块化入口**：每个模块都是独立的扩展入口——在 settings.json 中用 object-form 过滤即可裁剪到任意子集，例如只要三件套：
> ```json
> { "source": "/path/to/pi-lamboy-harness",
>   "extensions": ["extensions/10-pause.ts", "extensions/20-plan.ts", "extensions/80-truncation.ts"] }
> ```
> 入口以字典序加载，数字前缀钉死 tool_call 门控链（pause → plan → permission）；被过滤的模块不注册任何工具/命令/事件，零上下文成本。各功能的入口文件列于下方命令/工具表。

### Pause（冻结、检视）

- **`/pause` 全屏冻结** — 代理在下一个安全边界挂起（工具门卫）：进行中的调用跑完，什么都不中止，释放后从挂起点继续。全屏遮罩——主题色暂停符号、实时计时——esc/enter/space/ctrl+c 释放，并在会话流中留下状态行（`已恢复（暂停 13s）— 代理继续运行`）；暂停落在工具边界时遮罩带 `<tool_call>` 标签
- **安全边界** — 取消挂起的运行（AbortSignal）只释放该次等待，绝不动门禁
- **主题色遮罩** — 图标/标题/正文/提示全部使用当前主题的 `accent`/`text`/`muted`/`dim`，终端背景即遮罩底色；块字符（█ / ⏸）按单宽计量，暂停符号与下方文字精确对齐居中

### Goal 模块
- **Goal 生命周期** — active / paused / blocked / complete / usage_limited / budget_limited
- **Active Guard** — 已有 active 目标时 `create_goal` 拒绝静默覆盖，需 `replace=true` 或 `/goal replace`
- **Blocked 3 轮阈值** — 同一原因连续 3 次 block 才真正进入 blocked
- **完成判据门禁** — 声明了 completionCriterion 时，需在同一次 `update_goal` 调用中传 `verified=true` 才能 complete（已写入工具描述）
- **Budget 三重检测** — tokenBudget + turnBudget + wallClockBudgetMs，`set_goal_budget` 支持 turns/tokens/ms/s/min/hours
- **Goal Queue** — FIFO + high/normal 优先级 + auto-switch + prioritize/drop/skip
- **持久化** — appendEntry + session_start 恢复；计数按 goalId **单调合并**（max），过期 entry 不会把轮次/token 拉回过去；`clear()` 写入墓碑 entry，完成的目标不会复活
- **Context 注入** — `<untrusted_objective>` 标签注入 system prompt
- **Recovery** — compaction 保留 + context overflow 检测 + 429 检测

### Plan 模块
- **Plan Mode** — LLM 先探索代码库、写计划、审批后再执行
- **权限模型** — plan mode 不拦截 bash，bash 走正常的 permission mode（auto/yolo/manual）。只拦截 Write/Edit（非 plan 文件）
- **Plan 文件路径匹配** — 精确路径、`local://` scheme 文件名、解析后绝对路径在 `sessionDir/plans/` 下，三种方式均支持
- **ExitPlanMode 读盘** — 呈现时读取 plan 文件真实内容，与 LLM 写盘保持一致
- **Revise 保留 plan** — 评审选 Revise 或取消会以同一个 plan 对象（id/路径/内容）重新进入 plan 模式，不困住用户、不丢工作；评审超时 600s
- **恢复校验** — 无内容且磁盘无文件的过期 active-plan entry 会停用 plan 模式，而不是静默困住会话
- **Context 注入** — 注入 plan 到 system prompt

### Permission 模块
- **策略链** — auto / yolo / manual 三模式，安全策略（destructive、敏感文件）优先于模式短路
- **Destructive 检测** — `rm -rf` / `git push --force` / `drop table` / `git reset --hard` 等正则识别，每次必问，不被会话批准短路
- **敏感文件守卫** — `.env` / `id_rsa` / `*.key` 等读写拦截，auto 模式下也不放行
- **会话批准指纹** — 按 sessionId + 输入指纹记忆批准，不蜕变为"永久许可"
- **审批面板** — 编号对话框，按工具定制动作标题，数字键直选，四种结果：Allow once / Always allow（本会话）/ Deny / Deny with reason（理由回传给模型）。在 RPC 宿主（obsidian-pi 等）中，同样的四个选择走扩展 UI 协议（`select` / `input` / `confirm`）呈现，不再静默拒绝
- **AGENTS.md 指令** — 项目级（最近的裸 `AGENTS.md`，向上遍历）→ 跨工具 `~/.agents/AGENTS.md`，聚合生效；`destructive-ask-always` 可将 ask 升级为 deny
- **配置缓存** — 权限配置按文件 mtime 缓存，变更即时生效
- **持久化启动模式** — 可选 `"defaultMode": "auto" | "yolo" | "manual"`（全局 `~/.pi/agent/permissions.json` 或项目 `.pi/permissions.json`，冲突时全局优先）替代硬编码的 `manual` 启动模式，新会话直接以偏好模式启动；有 `/mode` 历史的会话仍恢复上次模式，`defaultMode` 是全新会话的起点

### TUI 模块
- **闭合框编辑器** — 移植 Kimi Code 的 `wrapWithSideBorders`：pi-tui 默认只有上下横线，后处理为 `╭╮│╰╯` 闭合框；上边框嵌入 spinner + 工作状态（Thinking/Streaming/Running tools），`plain | boxed | compact` 三种样式，默认 boxed；模型名需要时配置 `"modelInBorder": true`

  首个内容行带提示符（`│❯ text │`），padding 最低 2，边框永不触碰文本/光标。
- **`/tui` 命令** — 热切换编辑器样式（不重启，保留文本/焦点/键位），`/tui timing` 查看渲染耗时；配置持久化到 `~/.pi/agent/lamboy-tui.json`（项目级 `.pi/` 覆盖）
- **plan 徽标** — plan mode 激活时上边框显示 `plan` 文本徽标（不染边框色，与 pi 思考模式换色零冲突）
- **性能探针** — `PI_LAMBOY_TUI_TIMING=1` 统计 editor `render()` 的 P50/P99；spinner 仅在工作时以 250ms 帧率驱动
- **Shimmer 工作消息（OMP 风格）** — 编辑器边框里的工作状态文字带墙钟驱动的光带扫描（`classic` 余弦光带或 `kitt` K.I.T.T. 扫描灯）；亮头处 accent+bold 高亮，浅色文字在动画中也清晰。默认 `low: dim / mid: muted / high: accent`；`/tui shimmer <classic|kitt|disabled>` 热切换，配置持久化
- **稳定的动画帧率** — keep-alive 使用固定 200ms 静默门（≈10fps 上限），动画节奏恒定；流式时复用 pi 自然渲染零额外开销，agent 停滞时最多每秒 ~10 次全树渲染（大会话也可承受）

### Ask 模块（交互式提问）
- **`ask_user_question` 工具** — agent 一次发起 1-4 个结构化提问，共用一个标签页对话框：短标签页（`1/3 · header`，←/→/Tab 切换）、编号选项可带描述次行、`multi_select` 复选（空格切换、Enter 确认）、每题自动附带自由文本 **Other** 选项；数字键直选，方向键/jk 导航，Esc 取消
- **默认健壮** — 超长选项列表在有界窗口内滚动，重复答案自动去重
- **预览、备注、Chat 行** — 选项可携带 Markdown **预览**（宽终端双栏并排，窄终端堆叠）；`n` 键给选项附加**备注**；**Chat about this** 行以 `chat` 结果结束对话框，让用户先讨论再回答
- **共享对话框组件** — 权限审批复用同一组件（单选、无 Other）；print 模式下退化为文本提问，不阻塞；RPC 模式下权限审批回退到 `select`/`confirm`/`input`
- **结果回传** — 按题回传答案（多选为数组）；跳过的题与 Esc 取消区分上报
- **auto 模式安全** — auto 模式下 `ask_user_question` 被策略专门拒绝（防无人值守卡死）

### Todo 模块（内联任务计划）
- **内联面板** — 编辑器上方 widget，罗马数字阶段树（`Ⅰ. Scanner · 2/4`），`/todo toggle` 展开/折叠；完成的任务在 `PI_LAMBOY_TODO_CLEAR_DELAY` 秒后自动清除（默认 60，`0`=立即，`-1`=手动）——完成的计划自动淡出，不再残留
- **`/todo` 命令** — 完整 oh-my-pi 阶段模型：`init` / `start` / `done` / `drop` / `rm` / `append` / `export` / `import` / `copy` / `edit` / `add_notes` / `update_details`，裸 `/todo` 打印 Markdown
- **`todo_list` 工具** — 模型驱动的任务管理，同一套操作
- **认领/释放（claim/release）** — 多会话协作：已被他会话认领的任务不可再认领；`done` / `drop` 隐式释放认领
- **提醒系统** — agent 停下时未完成 todo 以 `<system-reminder>` 注入下一轮（最多 3 次，防抖）
- **Markdown 双向导出** — `/todo export/import` 跨会话持久化与分享
- **备注** — `add_notes` / `update_details` 逐任务笔记
- **阶段计数** — widget 头部显示 `N active · M pending · K done`
- **会话持久化** — 热重载与重启不丢

### 输出截断
- **超大工具结果落盘** — 超过截断阈值的结果写入 `<sessionDir>/tool-results/`，上下文中只保留净化后的头尾预览 + `output_path`，附 read 分页说明（`toolResultTruncation` 模式）
- **窗口感知阈值** — 阈值随当前模型上下文窗口缩放（`max(40k, 窗口 × 4 字符/token)`，上限 800k 字符 ≈ 200k token），1M 上下文的模型可保留远多输出；`PI_TRUNCATION_THRESHOLD` 可显式覆盖

### Perf lab 模块（性能测量层）
- **测量层定位** — 经 ssh 执行远程 GPU 基准、PyTorch profiler 分析与 A/B 显著性检验，与 pi-multiloop 松耦合（后者通过 verify 命令消费 `.perf/<run-id>.json`）
- **`bench_run`** — N 轮基准 + MAD 离群剔除 + P50/P95（而非均值——GPU 计时噪声大），并采集环境快照（nvidia-smi 型号/驱动/时钟），跨日对比可发现环境漂移
- **`profile_parse`** — torch profiler trace → 热点表（op/kernel、耗时占比、调用次数、形状），模型可直接推理
- **`metric_compare`** — Mann-Whitney 显著性判定（improve/regress/noise）；噪声主导时建议增加轮次而非误判

### Latex 工具链模块
- **编译与诊断** — `latex_compile` 本地运行 tectonic，把原始引擎输出转成结构化 `file:line` 错误 + 修复提示（undefined ref → 重跑/查 key，missing `$` → 检查数学环境定界符），模型可直接修稿而非读日志
- **引用一致性** — `bibtex_check` 交叉比对 `.tex` 引用与 `.bib`：未定义引用 / 未用条目 / 重复 key（元数据校验留给 pi-bib）
- **`/compile [file]`** — slash 快捷命令；无参数时扫描目录内唯一 main `.tex`
- **前置依赖** — 需要 `tectonic`（`brew install tectonic`）；缺失时返回友好的 "tectonic not found" 错误

## 命令

| 命令 | 说明 | 入口 |
|------|------|------|
| `/pause` | 冻结代理到下一个安全边界（esc/enter/space/ctrl+c 恢复） | `10-pause.ts` |
| `/goal <objective>` | 设置目标 | `40-goal.ts` |
| `/plan` | 进入/管理计划模式 | `20-plan.ts` |
| `/mode` | 权限模式（auto/yolo/manual） | `30-permission.ts` |
| `/todo` | 任务计划（阶段模型）；子命令：`start` `done` `drop` `export` `import` `copy` `edit` `toggle` | `60-todo.ts` |
| `/todo toggle` | 展开/折叠 todo 面板（替代原 `alt+t`） | `60-todo.ts` |
| `/tui` | 编辑器样式/shimmer/timing 热切换 | `70-tui.ts` |
| `/compile [file]` | LaTeX 编译快捷命令（唯一 main .tex 自动识别） | `95-latex.ts` |

> `/goal` `/plan` `/mode` `/tui` 均支持 Tab 子命令/参数补全。

## 工具

| 工具 | 说明 | 入口 |
|------|------|------|
| `create_goal` / `get_goal` / `update_goal` / `set_goal_budget` | 目标管理 | `40-goal.ts` |
| `enter_plan_mode` / `exit_plan_mode` | Plan Mode | `20-plan.ts` |
| `ask_user_question` | 标签页结构化提问（多选、Other 自由文本） | `50-ask.ts` |
| `todo_list` | 模型驱动的任务计划（内联面板） | `60-todo.ts` |
| `bench_run` | 远程 GPU 基准（ssh 到主机，N 轮 P50/P95/MAD 统计 + 环境快照）；结果落盘 `.perf/<run-id>.json` 供 pi-multiloop 的 verify 命令消费 | `90-perf.ts` |
| `profile_parse` | 解析 PyTorch profiler trace → 热点表（op/kernel、耗时占比、调用次数、形状） | `90-perf.ts` |
| `metric_compare` | 两次 `.perf/` 结果的 Mann-Whitney 显著性检验 → improve/regress/noise 判定 | `90-perf.ts` |
| `latex_compile` | 经 tectonic 编译 `.tex` → 结构化 `file:line` 错误 + 修复提示 + PDF 路径（需 `brew install tectonic`） | `95-latex.ts` |
| `bibtex_check` | 交叉比对 `.tex` 引用与 `.bib` → 未定义引用 / 未用条目 / 重复 key 报告 | `95-latex.ts` |

## 架构

core/adapter 分层：`packages/core/` 是**零 pi import** 的纯逻辑；
仓库根部是 pi 适配层（入口、pi-tui 组件、工具注册）。

```
pi-lamboy-harness/
├── extensions/            每模块一个扩展入口（字典序加载；数字前缀钉死
│   │                      tool_call 门控顺序：pause → plan → permission；
│   │                      可用 settings.json object-form 过滤任意子集）
│   ├── 10-pause.ts        /pause + 暂停门禁接线
│   ├── 20-plan.ts         Plan 模式工具/命令/持久化/门控
│   ├── 30-permission.ts   /mode + 策略链 + 审批对话框
│   ├── 40-goal.ts         goal 工具/命令/持久化/预算/徽标
│   ├── 50-ask.ts          ask_user_question 工具
│   ├── 60-todo.ts         todo_list + /todo + 内联面板
│   ├── 70-tui.ts          /tui + 编辑器 chrome + plan 徽标
│   ├── 80-truncation.ts   工具结果落盘（窗口感知）
│   ├── 90-perf.ts         bench_run / profile_parse / metric_compare
│   └── 95-latex.ts        latex_compile / bibtex_check + /compile
├── personal/              可选个人 pi 包（image2 + joyspace）— 单独安装
├── presets/               启用面预设 + switch.mjs（minimal/full 切换）
├── packages/core/         @lamboy/core — 纯逻辑，零 host import
│   ├── ports.ts           host 契约（PersistencePort、ScopeDirs）
│   ├── text-utils.ts      visibleWidth 等
│   ├── shell-output.ts    控制序列净化器
│   ├── stream-rules/      stream 入口规则引擎（纯函数）
│   ├── truncation/        超大工具结果落盘（纯函数）
│   ├── completions.ts     命令参数补全（Tab 补全）
│   ├── ask/               提问规格 + 答案格式化（纯函数）
│   ├── todo/              todo 模型 + 折叠策略 + 认领/释放（纯函数）
│   ├── goal/              Goal 模块（状态机 + 预算 + 队列 + 持久化）
│   ├── plan/              Plan 模块（工具白名单 + 路径守卫 + 注入）
│   ├── permission/        Permission 模块（策略链 + 审批契约）
│   ├── pause/             暂停门禁 + 全屏遮罩布局（纯函数，主题可注入）
│   ├── perf/              bench 统计 / torch-profile 解析 / ssh 组装（纯函数）
│   ├── latex/             tectonic 日志解析 + bib 一致性检查（纯函数）
│   └── tui/               box/config/parse/switch/timing/spinner（纯 chrome 件）
├── pause/                 适配层：/pause 遮罩组件
├── tui/                   适配层：LamboyEditor + 事件接线
├── ask/                   适配层：提问对话框 + ask_user_question 工具
├── todo/                  适配层：todo_list 工具 + 内联面板
├── perf/                  适配层：bench_run / profile_parse / metric_compare 工具
├── latex/                 适配层：latex_compile / bibtex_check 工具 + /compile 命令
└── tests/                 node 级单元测试（见下）
```

## 启用面预设（presets/）

"装了什么"由 `~/.pi/agent/settings.json` 的 `packages` 数组唯一决定；`presets/` 把这份配置版本化进仓库，**物理安装永不删除**，切换只改变启用面：

| 文件 | 作用 |
|------|------|
| `minimal.v0.1.json` | 最小单元：harness 8/10 模块（perf/latex 过滤掉）+ personal + 5 个整包（subagents/web-access/research/mcp-adapter/focus-bell）+ pie 过滤为 loop/files/powerline-footer + grill-with-docs skill |
| `full.snapshot.2026-09-06.json` | 全量基线：原 13 包 + personal + grill |
| `switch.mjs` | 切换脚本：时间戳备份 → 原子替换 packages 数组 → 散落副本移入 `disabled/` → 前后 diff 报告 |
| `catalog.md` | 按需加回菜单 + 冲突规则 |

```bash
node presets/switch.mjs list                  # 查看预设与当前状态
node presets/switch.mjs diff minimal.v0.1     # 预览变更（不动文件）
node presets/switch.mjs minimal.v0.1          # 切换到最小集
node presets/switch.mjs full                  # 恢复全量
```

**已知硬规则**（详见 `presets/catalog.md`）：

1. **工具名冲突 = 启动失败**（不是降级）。harness `get_goal`/`update_goal` 与 pi-multiloop quick-goal 同名，两者不可同时启用（已实测）。复现：两者共存时 pi 直接报 `Tool "get_goal" conflicts` 并拒绝启动。
2. **object-form 过滤只认 manifest 入口路径**：上游包改名入口会使过滤条目静默失效（表现为该扩展消失）；每次 `pi update` 后建议对比工具清单。

## 个人附加包（personal/，可选装）

与主包无代码依赖的独立 pi package，单独安装：

- **`generate_image` 工具**（京东云 gpt-image2，OpenAI Images 兼容）：画图请求重接生图 API，本地落盘并插入对话。配置：环境变量 `JD_IMAGE_*` 或 `~/.pi/agent/image2.json`
- **`joyspace-md-import` skill**：经 Playwright 驱动 Slate 编辑器把 Markdown（含图片/表格）写入京东 JoySpace 在线文档

```bash
# 安装前先移除全局散落副本（防双注册冲突，已实测会致命报错）
mv ~/.pi/agent/extensions/image2.ts ~/.pi/agent/disabled/extensions/ 2>/dev/null
mv ~/.pi/agent/skills/joyspace-md-import ~/.pi/agent/disabled/skills/ 2>/dev/null
pi install /path/to/pi-lamboy-harness/personal
cd /path/to/pi-lamboy-harness/personal/skills/joyspace-md-import/scripts && npm install   # 首次需装脚本依赖
```

## 测试

无需模型额度的 node 级单元测试（21 个套件，631 项断言）：

```bash
npm test                                        # 全部套件（node tests/run-all.mjs）
npm run typecheck                               # 全包 tsc 类型检查（strict, es2024）
```

或逐个运行：

```bash
node tests/approval-rpc.test.mjs                  # RPC 审批兜底（select/confirm）21 项
node tests/ask.test.mjs                           # ask 规格/对话框/答案/审批标题 118 项
node tests/goal.test.mjs                          # Goal 状态机 + 单调恢复 32 项
node tests/pause-gate.test.mjs                    # 暂停门禁 + 全屏渲染 54 项
node tests/permission.test.mjs                    # Permission 守卫层链 20 项
node tests/perf-adapter.test.mjs                  # perf 适配器 mock-ssh 全链路 9 项
node tests/perf-parsers.test.mjs                  # torch profiler + stdout 基准提取 10 项
node tests/perf-remote.test.mjs                   # ssh 命令组装快照 15 项
node tests/perf-stats.test.mjs                    # 分位数/MAD/离群/Mann-Whitney/对比 11 项
node tests/plan.test.mjs                          # Plan 模式往返 + 恢复校验 37 项
node tests/shell-output.test.mjs                  # 输出净化器 21 项
node tests/shimmer.test.mjs                       # shimmer 扫描动画引擎 10 项
node tests/stream-rules.test.mjs                  # 流式 entry 规则 14 项
node tests/todo.test.mjs                          # todo 模型 + 折叠策略 + 认领/释放 117 项
node tests/truncation.test.mjs                    # 结果落盘截断 + 窗口感知阈值 21 项
node tests/tui-adapter.test.mjs                   # TUI 适配器 working-state 渲染路径 4 项
node tests/tui-box.test.mjs                       # TUI 闭合框/配置/探针/切换 63 项
node tests/tui.test.mjs                           # TUI 折叠/键位/补全/spinner 36 项
node tests/latex-parse.test.mjs                    # tectonic 日志解析 15 项
node tests/latex-bib.test.mjs                      # bib 一致性 + 夹具 4 项
node tests/latex-adapter.test.mjs                  # latex 工具 + /compile（mock tectonic）11 项
```

测试支持 Node 22/24/26（22.6–22.17 走 `--experimental-strip-types`，更早的用 `tests/ts-esm-loader.mjs` TypeScript 转译；22.18+ 原生擦除类型）。

## Roadmap

- ~~**最小集 v0.1**~~ ✅ 已完成（2026-09-06）：多入口改造 + presets 机制 + personal 包收录（决策链：`plans/2026-09-06-packages-ecosystem-audit.md` → `2026-09-06-restructure-briefing.md` → `2026-09-06-minimal-preset-plan.md` → `plans/minimal.v0.1.md`）
- **i18n** — harness 界面文案与通知双语化（文档已拆分中英）
- **公式渲染转正** — 待压缩路径的上下文安全性确认后，合入 `feature/math-renderer`
- **clustered diff 预览** — edit/write 审批消息中的 ±3 行聚簇 diff（P1 批次延迟项）
- **explore-sync** — 实验历史蒸馏入 pi-research 知识库（roadmap §6.3 遗留）

## 依赖

- Pi >= 0.80.0
- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`（peers）
- `typebox`

## 实验分支

- [`feature/math-renderer`](https://github.com/MuseLinn/pi-muselinn-harness/tree/feature/math-renderer) — 通过 [txm](https://github.com/thatmagicalcat/txm) 在助手消息中渲染 `$$...$$` 显示公式（单元格级 2D 排版，Windows Terminal 可用；无图像协议）。上下文安全：每次 LLM 调用前恢复原始 Markdown。`cargo install txm` 后以 `/tui math on` 启用。

## 致谢

本扩展的设计和实现参考了以下开源项目，在此表示感谢：

### [Kimi Code](https://github.com/MoonshotAI/Kimi-code) (Moonshot AI)
- Agent Swarm 并发执行架构（max_concurrency worker 池、30min 超时、run_in_background）
- Goal 系统设计（GoalActor 追踪、Budget Report、blocked 3 轮阈值、Context 注入）
- Plan Mode 生命周期（enter/exit/approve/reject、ExitPlanMode 读盘）
- Permission 策略链（auto/yolo/manual、destructive 必问、AGENTS.md 优先级）
- Cron 定时任务（5 字段 + jitter + 7 天 stale + 50 上限）
- TUI 组件设计（盲文进度条、三栏任务浏览器、`wrapWithSideBorders` 闭合框编辑器）
- 取消/恢复机制（AbortSignal 链、UserCancellationError）

### [pi-spark](https://github.com/zlliang/pi-spark) (zlliang)
- 编辑器上边框信息位设计（spinner + 工作状态 + 模型名嵌入边框）
- 组件替换式 TUI 改造路径（`setEditorComponent` / `setFooter` / `setWidget`）

### [@narumitw/pi-goal](https://www.npmjs.com/package/@narumitw/pi-goal) (narumitw)
- Goal Queue FIFO + Auto-switch 机制
- usage_limited / budget_limited 状态设计
- Wrap-up 指令注入（预算耗尽后的行为）
- Stale Tool Blocking 设计
- Compaction 保留策略

### [pi-codex-goal](https://www.npmjs.com/package/pi-codex-goal) (fitchmultz)
- Goal 持久化方案（appendEntry + session_start 恢复）
- Goal 状态转换逻辑
- Budget 检查机制
- Recovery Machine 概念（简化版）

---

**注意**：本扩展大部分为独立实现。例外：`tui/box.ts` 的 `wrapWithSideBorders` 移植自 Kimi Code（MIT），已保留出处注释并按 MIT 条款使用。

## Changelog

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
