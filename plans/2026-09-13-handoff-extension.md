# Handoff Extension — 设计与实现记录（2026-09-13）

## 需求

用户需要在不同 session 之间进行任务交接。参考 ogulcancelik/pi-extensions 的
`pi-handoff` 包（command + tool + context guard 三触发器），为本 harness 补充
handoff 扩展。

## 调研结论（证据）

1. **参考包已弃维护**。其 README（raw `packages/pi-handoff/README.md`）明确说明：
   extension tool 的 `execute` 收到的是 `ExtensionContext`，**没有** `newSession`
   ——该能力只存在于 `ExtensionCommandContext`（command handler）。已在本机
   `pi-coding-agent/dist/core/extensions/types.d.ts:372`（tool execute 签名）与
   `:248-260`（ExtensionCommandContext.newSession）双重验证。agent-initiated 工具
   直接开新 session 需要 setTimeout hack + in-band 隐藏 prompt，脆弱。
2. **作者本人推荐改用官方 example**
   （`examples/extensions/handoff.ts`，随 pi 0.85.1 发布）：command handler 内
   读 branch → `modelRegistry.complete` 独立摘要调用 → `ui.editor` 审阅 →
   `ctx.newSession({ parentSession })` + `setEditorText` 预填。全程使用 command
   context，无时序 hack。
3. `session_query` 并非 pi 内置工具（grep pi 0.85.1 dist 无结果）——参考包 prompt
   中引用它属于超前假设。本实现交接 prompt 中改为引用 parent session 文件路径
   （JSONL，新 session 可直接 read）。
4. `convertToLlm` / `serializeConversation` / `BorderedLoader` 均从
   `@earendil-works/pi-coding-agent` 导出（0.84.2 typecheck 依赖 dist/index.d.ts
   已验证，运行时宿主 0.85.1 同 API）。

## 设计

融合两者：**触发器参考 pi-handoff，执行路径采用官方 example**。

### 文件布局（仓库惯例）

```
extensions/85-handoff.ts          入口：命令注册 + context guard + handoff 工具
handoff/commands.ts               命令适配层（/handoff 流程编排）
packages/core/handoff/prompt.ts   纯逻辑：branch 切片、系统 prompt、用户消息构造
packages/core/handoff/guard.ts    纯逻辑：guard 配置解析、draft 状态条目 helpers
tests/handoff.test.mjs             纯函数单测（无 pi runtime）
```

### 三个触发器

1. **`/handoff <goal>`（用户主动，主路径）**
   - `ctx.mode === "tui"` 守卫；无 model / 无参数 / 空分支报错退出
   - `getHandoffMessages(branch)`：compaction 感知切片（官方 example 同源逻辑）
   - `convertToLlm` + `serializeConversation` 序列化 → `modelRegistry.complete`
     独立摘要调用（BorderedLoader，可 abort）
   - `ctx.ui.editor` 审阅/编辑生成的交接 prompt
   - `ctx.newSession({ parentSession, withSession })`：新 session 记录 parent，
     `setEditorText` 预填交接 prompt，用户确认后提交

2. **`handoff` 工具（agent 主动起草）**
   - 工具参数只有一个 `prompt`：由 agent 自己写的完整交接 prompt（它有全部上下文）
   - 工具 `appendEntry("lamboy:handoff-draft", { prompt })` 存草稿（custom entry
     不进 LLM context，无污染）
   - 工具返回后由扩展通过 `pi.sendUserMessage("/handoff", { expandPromptTemplates:
     true, deliverAs: "followUp" })` 派发命令（agent 空闲后执行命令流程）
   - `/handoff` 命令先检测最近 draft：命中则**跳过模型再生成**，直接进 editor
     审阅（agent 已有上下文，重生成是浪费）；审阅后照常 newSession
   - 设计要点：所有 session 控制仍发生在 command handler 内，规避弃维护包的死穴

3. **Context guard（自动提醒，turn_end）**
   - 阈值 90%（`PI_LAMBOY_HANDOFF_THRESHOLD` 可调，`PI_LAMBOY_HANDOFF=0` 整体
     禁用，`PI_LAMBOY_HANDOFF_GUARD=0` 仅禁 guard）
   - `ctx.ui.select` 询问："Context at N% — handoff to a new session?"
     - Yes → `setEditorText("/handoff ")` 预填，用户补个 goal 即可交接
       （事件处理器中不能调 newSession，所以不越权）
     - No → 本 session 抑制（`appendEntry` 持久化，session_start 时从 branch
       回读，reload 不丢）
   - 每 session 只提示一次；percent 为 null（刚 compaction 后）跳过

### 交接 prompt 结构（模型生成，用户可编辑）

官方 example 的 SYSTEM_PROMPT 为基础（Context / Files / Task 三段），追加
parent session 页脚：注明上一个 session 的 JSONL 路径与"何时该回查"的指引。

## 验证计划

- `npm run typecheck`（tsc strict，0.84.2 类型）
- `node tests/run-all.mjs`（新 suite `handoff.test.mjs` + 全量回归）
- settings.json 注册后 `pi` 实际加载（用户侧验证）
- README.md / README.zh-CN.md 增补条目

## 决策记录

- 不复刻弃维护包的 agent-tool-直接-newSession 路径（作者自认脆弱，类型层面
  就不支持）；改为"agent 起草 → draft 条目 → 命令流程接管"，能力等价、路径可靠。
- 不引用不存在的 `session_query` 工具；改引用 parent session 文件路径。
- 编号取 85（80-truncation 与 90-perf 之间，handoff 与 context 管理同域）。
