# 最小单元（minimal v0.1）构建方案（待确认稿）

> 日期：2026-09-06 · 状态：**待用户确认**
> 前置：`plans/2026-09-06-packages-ecosystem-audit.md`（全景）、`plans/2026-09-06-restructure-briefing.md`（拆分机制）
> 目标（用户原话归纳）：① 精简实际使用的工具到最小单元 ② 全局保留安装/使用任何工具的能力 ③ 部分工具以"可选项"形态保留 ④ 构建产物可安装、可替换当前 pi agent 的实际启用状态

---

## 0. 先回答核心问题：怎么构建

**不建议"新分支 + release"，建议"配置即版本"（preset 机制）。**

| 候选方式 | 判定 | 理由 |
|---|---|---|
| ❌ 新分支（minimal 分支裁剪代码） | 不采用 | "最小化"的本质是**启用配置的状态**，不是代码状态。分支 = 代码线分叉：main 修 bug 要双向 cherry-pick，模块演进两套现实，维护成本远超收益。且 harness 只是 15 个组成里的一员，分支只覆盖自建部分。 |
| ❌ npm release 发布 | 不采用 | 个人单机使用，local-path 安装（`pi install /path`）已完整可用且改动即生效；npm 发布只对多机分发有价值，还引入发布流程负担。 |
| ✅ **main 分支 + presets/ 目录 + git tag** | 采用 | pi 生态里"装了什么"唯一由 `settings.json` 的 `packages` 数组决定（官方 packages.md）。把这份配置**版本化进仓库**，最小版 = 一份 JSON + 一条切换命令。代码层唯一可能需要的改造是 harness 模块可选化（见 §2，是否做取决于你的功能清单）。 |

**核心洞察**：你现在的 13 包 + 全局 extensions/skills，物理上全部保留（`~/.pi/agent/npm/` 一个文件都不删），"最小版"只改变**启用面**——这天然满足"不删除使用任何工具的能力"：恢复全量 = 再跑一次切换命令，无网络依赖、无版本漂移。

---

## 1. 目标态设计：三层结构

```
┌─ 能力层（完全不动，随时可用）────────────────────────┐
│  ~/.pi/agent/npm/node_modules/*   13 个第三方包物理文件 │
│  ~/.pi/agent/mcp.json             Zotero MCP 配置      │
│  本仓库全部源码 + personal/       自建能力             │
└──────────────────────────────────────────────────────┘
                    ↑ 启用/禁用只发生在下面两层
┌─ 启用层（版本化，可一键切换）────────────────────────┐
│  ~/.pi/agent/settings.json 的 packages 数组            │
│  ← 由 presets/minimal.v0.1.json 写入（最小集）         │
│  ← 由 presets/full.snapshot.json 写入（全量恢复）      │
└──────────────────────────────────────────────────────┘
┌─ 装饰层（随 preset 联动禁用）────────────────────────┐
│  ~/.pi/agent/extensions/image2.ts   （自动加载目录）   │
│  ~/.pi/agent/skills/joyspace-md-import/               │
│  → 最小集不含 personal 时，移入 ~/.pi/agent/disabled/ │
│    （pi 只自动加载 extensions/ skills/ 本目录，子目录  │
│     disabled/ 不扫描 → 等于禁用但文件保留）           │
└──────────────────────────────────────────────────────┘
```

**为什么直接编辑 settings.json 而不用 `pi remove`**：`pi remove` 面向卸载语义，行为上可能清理物理安装；直接编辑 `packages` 数组则物理包 100% 保留，重新启用只需把条目加回来 + 重启 pi——这是"保留能力"的最强保证。（编辑后需重启 pi 生效，settings 为启动时读取。）

---

## 2. 唯一可能的代码改造：harness 模块可选化（取决于你的清单）

harness 现在是**单入口**（`pi.extensions: ["./index.ts"]`，10 模块全部在一个入口注册）。官方 object-form filtering 只能按 manifest 入口文件过滤——单入口 = 全有或全无。因此：

| 你的最小集清单情况 | 需要的改造 |
|---|---|
| **路径 A**：不含 harness，或含**全量** harness | **零代码变更**。纯 presets 配置工作，半小时级交付 |
| **路径 B**：只含 harness 的**部分**模块（如只要 Goal+Truncation，不要 TUI/Latex） | 需要**多入口改造**（v0.14.0） |

### 路径 B 改造设计（如需要）

```
pi-lamboy-harness/
├── extensions/            # 新：每模块一个入口（manifest: "extensions": ["./extensions"]）
│   ├── goal.ts            # create_goal 等 4 工具 + /goal + persistence 绑定
│   ├── plan.ts            # enter/exit_plan_mode + /plan + 注入接线
│   ├── permission.ts      # /mode + tool_call 守卫接线（横切）
│   ├── ask.ts             # ask_user_question
│   ├── todo.ts            # todo_list + /todo + 面板
│   ├── tui.ts             # /tui + 编辑器 chrome
│   ├── pause.ts           # /pause
│   ├── truncation.ts      # 工具结果落盘包装（横切）
│   ├── perf.ts            # bench_run 等 3 工具
│   └── latex.ts           # latex_compile 等 2 工具 + /compile
└── index.ts               # 退役（或保留薄壳转发，兼容旧安装）
```

- 模块间解耦点已知 3 处，均有解法：persistencePort（各入口自建，现状已是 try/catch 防护）；plan→tui 的 badge provider（条件注入 + no-op 兜底）；permission/plan 的系统提示注入（各自独立订阅事件）
- **拆分机制与第三方包完全统一**（pie 的 17 扩展就是这种结构）——你的心智模型只剩一套：装什么 = packages 数组；包内留什么 = object-form 过滤
- 默认行为不变：直接 `pi install` harness = 10 模块全量（目录加载全部入口）；最小集通过 settings.json 过滤，例如只要三件套：
```json
{ "source": "/Users/liulian.leliy/github-projects/pi-lamboy-harness",
  "extensions": ["extensions/goal.ts", "extensions/permission.ts", "extensions/truncation.ts"] }
```
- 工作量约 1 天（index.ts 702 行拆解 + 解耦 + 全量测试回归，21 套件必须全绿）
- ⚠️ 一个待实测点：local-path 源 + object-form 过滤的组合（文档未明说，构建时用 `pi -e` 实测验证；若不支持，备选方案是 harness 走 git tag 源安装）

---

## 3. presets/ 目录设计（新增于本仓库）

```
presets/
├── minimal.v0.1.json          # 最小集 packages 数组（含 object-form 过滤条目）——你的功能清单确定后生成
├── full.snapshot.2026-09-06.json   # 当前 13 包全量快照（从 settings.json 冻结，恢复用）
├── switch.mjs                 # 切换脚本（node 零依赖）
└── catalog.md                 # 功能目录：什么需求 → 启用什么（按需加回的菜单）
```

**switch.mjs 行为**（原子操作，失败即回滚）：
1. 备份 `~/.pi/agent/settings.json` → `settings.json.bak-<timestamp>`
2. 读入目标 preset，替换 `packages` 数组（**只动这一个键**，其余设置如 theme/defaultModel 原样保留）
3. 联动处理全局装饰层：preset 不含 personal 时，把 `extensions/image2.ts`、`skills/joyspace-md-import` 移入 `~/.pi/agent/disabled/`；含则从 disabled/ 移回
4. 打印启用面 diff（前后工具/命令清单对比）+ 提示重启

**用法**：
```bash
node presets/switch.mjs minimal.v0.1    # 切到最小集
node presets/switch.mjs full            # 恢复全量
node presets/switch.mjs diff            # 只看差异不动手
```

**catalog.md**（示例形态，清单确定后成文）：

| 需求场景 | 加回条目 |
|---|---|
| 要画图 | personal 包（switch 脚本自动含 image2） |
| 要发 JoySpace 文档 | personal 包 |
| 要查文献 | pi-mcp-adapter（Zotero）+ pi-bib |
| 要跑论文流程 | 学术三包（建议项目级 `pi install -l` 于论文仓库） |
| 要循环优化 | pi-multiloop + pi-autoresearch + pi-lifeline |
| ... | ... |

---

## 4. 交付与验证流程（确认后执行）

```
① 你确认本方案（含 §2 路径 A/B 的判定）
② 你给我功能清单（模板见 §5）
③ 我构建：
   - 路径 B 时：harness 多入口改造 → npm test 21 套件全绿 + typecheck → 版本 0.14.0
   - 生成 minimal.v0.1.json + full 快照 + switch.mjs + catalog.md
   - git commit + tag（minimal-v0.1）
④ 你安装（一条命令）：
   node presets/switch.mjs minimal.v0.1 && 重启 pi
⑤ 验证（我提供核对清单）：
   - 新会话 available_tools / skills 与 minimal.v0.1.json 预期一致
   - 全局目录无双注册
   - 恢复演练：switch full → 重启 → 工具回归（证明能力保留）
```

---

## 5. 请你提供功能清单（确认方案后回复即可）

**格式建议**——按来源层勾选，不确定的就标 `?`（我会给出建议并说明理由）：

```
【pi 原生】默认自动在，无需选择（read/write/edit/bash/sessions 等）

【harness 自建模块】（0-10 个；若少于 10 个 → 触发路径 B 改造）
goal / plan / permission / ask / todo / tui / pause / truncation / perf / latex

【第三方包】（0-13 个；可整包或说明要其中的什么）
pi-subagents / pi-web-access / pi-research / pi-mcp-adapter /
pi-multiloop / pi-autoresearch / pi-lifeline /
pi-bib / pi-critique / ars / superpowers-zh / pi-agent-extensions / pi-focus-bell

【personal】
image2 生图 / joyspace 导入（都不装则进入 disabled/）
```

一个诚实的建议供参考：最小集的**底线候选**通常是 pi-web-access（没有搜索/抓取，研究类任务直接残废）+ superpowers-zh 的核心流程 skill（方法论纪律，且它是纯 skill 不占工具表）+ pi-subagents（若你的任务需要并行/隔离）——但最终以你的实际任务画像为准。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| local-path + object-form 过滤未验证 | 构建时 `pi -e` 实测；备选：harness 改用 git tag 源 |
| 上游包入口改名 → 过滤条目静默失效 | catalog.md 维护核对清单；每次 `pi update` 后跑 `switch.mjs diff` 比对 |
| settings.json 手改出错 | switch.mjs 先备份、JSON schema 校验后写入、失败回滚 |
| harness 改造破坏现有功能 | 全量测试回归（21 套件 631 断言）+ typecheck 是发布门槛；改造不动 packages/core 纯逻辑层 |
| 最小集漏装导致某任务卡住 | catalog.md 一分钟定位该加回什么；加回条目是纯配置操作 |
