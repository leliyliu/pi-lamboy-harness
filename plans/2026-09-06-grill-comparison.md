# Grill 包对比：grill-me vs grill-with-docs（2026-09-06 调研）

> 需求来源：`plans/minimal.v0.1.md`——"加上 grill-with-docs 或者 grill-me，先检索并讨论优劣之后，我来决定选哪个"。
> 调研方式：npm/jsdelivr README + SKILL.md 全文拉取（2026-09-06），pi.dev gallery 条目核对。

## 候选总览（实际找到 4 个相关包）

| 包 | 版本/许可 | 形态 | 一句话 |
|---|---|---|---|
| **@firstpick/pi-extension-grill-me** | 0.1.5 | 扩展（命令+工具） | 确定性设计访谈：一次一个决策，产出可复用 summary |
| **@majorgilles/pi-grill-me** | 0.3.0 / MIT / 98 周下载 | 扩展（重） | 苏格拉底式规划：checkpoint + 强制产出阶段 + 只读门控 |
| **@barlevalon/grill-with-docs-skill** | 0.3.0 / MIT | **纯 skill**（零代码） | 烤问 + 领域建模：边问边把术语/决策沉淀为 CONTEXT.md + ADR |
| pi-grill2docs-skill | — | 纯 skill | 同上概念（grilling + domain-modeling → ADR/词汇表），另一作者 |

四个包同源思想均指向 **Matt Pocock 的 skills 仓库**（grilling / domain-modeling 纪律）。

## 逐个详解

### 1. @firstpick/pi-extension-grill-me — 轻量确定性访谈

- **入口**：`/grill-me [plan]` 启动访谈
- **机制**：确定性工具驱动（README 强调 "Deterministic design interview"）——一次问一个决策，**显式记录**每个已解决问题的答案，未解决问题单独跟踪
- **产出**：可复用的 summary（供后续 plan/implementation 使用）
- **优点**：最轻、行为可预期（工具驱动不靠提示词自觉）、安装即用
- **缺点**：功能面窄（无产出格式选择、无文档沉淀、无只读门控）；版本 0.1.x 早期；TECHNICAL.md 在另一仓库（firstpick forge）

### 2. @majorgilles/pi-grill-me — 重型苏格拉底规划

- **入口**：`/grill <topic>`（+ `/checkpoint`、`/grill intent|output|research|status|stop` 子命令族）
- **机制**：上下文注入 + 6 个 assistant 工具（`grill_set_alternatives` / `grill_update_checkpoint` / `grill_enter/finish_output_selection_phase` / `grill_enter/finish_output_phase`）
- **特色**：
  - **Tab 候选答案循环**：候选答案激活时 Tab 填充建议回复、循环切换、Shift+Tab 回退
  - **强制产出选择阶段**：访谈结束必须进入 output-selection，明确列出可选产出（GitHub issues / design doc / README / ADR / PRD / 实现计划 / 研究简报 / summary / 教程大纲 / 测试计划 / changelog），可多选
  - **只读门控**：interview 阶段封锁 edit/write/变异 bash，产出计划获批后才放行
  - **intent 预设**：auto/plan/learn/research/content/decide
- **优点**：功能最全、门控与 harness Permission 理念同构、产出管道完整
- **缺点**：**与 minimal 集已有能力重叠**——只读门控 vs harness plan/permission 门控（双轨）；6 个工具常驻工具表（上下文成本）；概念多（intent/output/research 三套子命令）
- **安装**：npm 或 git（`npm:@majorgilles/pi-grill-me`）

### 3. @barlevalon/grill-with-docs-skill — 烤问 + 文档沉淀（推荐倾向）

- **入口**：`/grill-with-docs`（skill 调用，主动触发，agent 不会自作主张用）
- **机制**：**纯 skill（一个 SKILL.md，零运行时代码、零工具注册）**，组合两条纪律：
  1. **grilling**：一次一问、每问附推荐答案、按依赖序走决策树、能查代码就不问用户
  2. **domain-modeling**：烤问过程中实时维护领域模型——术语冲突立刻指出、模糊措辞提出规范词、术语敲定立即更新 `CONTEXT.md`；决策满足"难逆转+无上下文会困惑+真实权衡"三条件时**提议**写 ADR（`docs/adr/`），且是提议不强制
- **产出**：**沉淀进仓库的持久资产**——CONTEXT.md 术语表 + ADR 决策记录（git 版本化、跨会话跨 agent 复用），结尾附已解决决策/开放问题/变更文档/下一步
- **优点**：
  - 零代码零工具——与 minimal 集零冲突（无工具名撞车风险、无上下文工具表膨胀）
  - 产出与你的工作方式高度契合（AGENTS.md 证据纪律 + 文档化交互要求）
  - 懒创建：无 CONTEXT.md 的仓库不预生成空文件
- **缺点**：纯提示词纪律（无工具强制，agent 可能不严格遵守——靠 skill 指令）；无产出格式选择阶段；无只读门控（但这层 minimal 集已有 harness permission）
- **来源**：Matt Pocock skills 的 pi 移植（barlevalon/skills）

### 4. pi-grill2docs-skill — 同概念备选

与 #3 同思路（grilling + domain-modeling → ADR/词汇表），另一作者实现。作为 #3 的备选，若 #3 停更可替换。

## 对比结论（结合你的 minimal 集语境）

| 维度 | @firstpick grill-me | @majorgilles pi-grill-me | @barlevalon grill-with-docs |
|---|---|---|---|
| 与 minimal 集冲突风险 | 低（1 命令+若干工具） | 中（6 工具 + 只读门控与 harness 双轨） | **零**（纯 skill） |
| 上下文成本 | 低 | 中高（6 工具定义常驻） | **零**（仅 skill 描述行） |
| 产出价值 | 会话内 summary | 多格式产物（可含 GitHub issues） | **仓库持久资产**（CONTEXT.md + ADR） |
| 门控 | 无 | 有（与 harness 重叠） | 无（harness 已有） |
| 成熟度 | 0.1.x 早期 | 0.3.0 + 98 周下载 | 0.3.0（Matt Pocock 移植） |

**我的推荐：`@barlevalon/grill-with-docs-skill`**。理由：① 零冲突零上下文成本——完美匹配"最小单元"目标；② 产出（CONTEXT.md + ADR 沉淀）与你的证据纪律/文档化交互工作流契合；③ 它缺的门控 minimal 集已有（harness permission/plan），缺的产出选择可以事后手动要求。若你更想要"强制产出选择 + Tab 候选答案"的重交互体验，选 @majorgilles；若只要最简访谈记录，选 @firstpick。

## 加入方式（任选其一后执行）

```bash
# 方案 A（推荐）：加入 minimal 预设
# presets/minimal.v0.1.json 的 packages 数组追加: "npm:@barlevalon/grill-with-docs-skill"
# 然后: node presets/switch.mjs minimal.v0.1

# 方案 B：仅试用不进预设（临时加载）
pi -e npm:@barlevalon/grill-with-docs-skill

# 方案 C：仅当前项目启用（论文/设计项目）
cd <project> && pi install -l npm:@barlevalon/grill-with-docs-skill
```

## 证据

- @firstpick README 全文：cdn.jsdelivr.net/npm/@firstpick/pi-extension-grill-me@0.1.5/README.md
- @majorgilles README 全文：cdn.jsdelivr.net/npm/@majorgilles/pi-grill-me@0.3.0/README.md（含命令表/工具清单/只读门控/Tab 交互说明）
- @barlevalon SKILL.md 全文：cdn.jsdelivr.net/npm/@barlevalon/grill-with-docs-skill@0.3.0/SKILL.md（四步流程：加载领域上下文→烤问循环→内联维护领域模型→节制提议 ADR）
- npm 元数据（版本/许可/周下载）：npmjs.com 各包页面（2026-09-06）
