# 授权/提问提示标注「哪个 workspace」— 设计与实施计划

> 日期：2026-11-02 · 需求：「ask permission 的时候我不清楚是哪个 workspace 的，能否改进」
> 实施完成后本文归档到 `plans/2026-11-02-permission-prompt-workspace-label.md`。

## 0. 结论先行

**能改，且成本低。** 终端外的弹出提示（pinotify 浮窗）与 TUI 审批面板当前都**不含任何 workspace 标识**；
而同一套通知链路里的「任务落定」提示**已经**带了项目名（`pi · <basename(cwd)>`）——属于遗漏而非设计。
修法：抽一个纯函数 `resolveWorkspace(cwd, env)`（读 Paseo 的本地 `workspaces.json` / `projects.json`，
回落路径名），把结果塞进 attention 载荷 + 审批面板 body，弹窗标题渲染成 `🔐 需要授权 · pi-lamboy-harness`。

## 1. 问题证据（当前行为）

| 位置 | 现状文案 | 有 workspace？ |
|---|---|---|
| 弹出提示标题（`personal/extensions/notify.ts:129`） | `🔐 需要授权` | ❌ |
| 弹出提示正文（`packages/core/permission/index.ts:157-162`） | `bash: <policy message>` | ❌ |
| TUI 审批面板问句（`extensions/30-permission.ts:57-60`） | `Run this command?\nApproval Required: <message>` | ❌ |
| RPC 审批（`packages/core/permission/approval-rpc.ts:57`） | `${title}: ${message}` | ❌ |
| 超时放行通知（`packages/core/permission/index.ts:274`） | `⏰ 授权超时放行 bash: ...` | ❌ |
| 任务落定通知（`personal/extensions/notify.ts:190`） | `pi · ${basename(ctx.cwd)}` | ✅ |
| 提问 / 计划审批通知（`ask/index.ts:205-210`, `plan/tools.ts:117-121,152`） | `❓ 需要你回答` / `📋 计划待审批` | ❌ |

关键点：`notify.ts` 的 attention 分支只渲染 `req.title`/`req.body`，仓库侧 `emitAttention()` 也从不传 cwd
（`packages/core/attention/index.ts:40-56` 的 `AttentionRequest` 只有 kind/title/body/mode）。
Paseo 里同时跑多个 workspace（实测 `paseo workspace ls --json` 有 5 个活跃 workspace）时，
弹窗无法区分来源 —— 这就是用户的痛点。

## 2. 标签数据从哪来（实测证据）

本进程环境变量（实测 `env`）：

```
PASEO_HOME=/Users/liulian.leliy/.paseo
PASEO_WORKSPACE_ID=wks_551d14bc312208c3
PASEO_TERMINAL_ID=c3bf9321-...      # 无 PASEO_AGENT_ID（未注入）
```

本地映射文件（无需 daemon、无需子进程）：

- `~/.paseo/projects/workspaces.json`（list）：`workspaceId → {cwd, kind, displayName, title, branch, projectId, archivedAt}`
  实测当前记录：`{cwd: /Users/.../pi-lamboy-harness, kind: "local_checkout", displayName: "main", title: null}`
  实测目录类 workspace：`{cwd: .../policy-optimization, kind: "directory", title: "短文桶驱逐策略优化"}`
- `~/.paseo/projects/projects.json`（list）：`projectId → {displayName, rootPath}`，实测
  `prj_f3612030f72fd724 → displayName "pi-lamboy-harness"`、`prj_3d19cbd21c0fd8e3 → "JDnotes"`

**为什么不调 `paseo workspace ls --json`**：实测 280ms（起 node 进程），且依赖 daemon 存活；
读两个本地 JSON 是 O(1) 文件读 + mtime 缓存，天然 fail-safe。代价是依赖 Paseo 的私有落盘格式（见 §7 风险）。

**标签规则**

| 场景 | 标签 |
|---|---|
| Paseo 命中，`title` 非空且 ≠ `displayName` | `项目 · 标题`（例：`policy-optimization · 短文桶驱逐策略优化`） |
| Paseo 命中，`title` 为空（`local_checkout` 常见） | `项目`（例：`pi-lamboy-harness`；不显示无信息量的 `main`） |
| Paseo 命中但记录的 `cwd` ≠ 传入 `cwd` | 走路径回落（见下），**不**误用父 workspace 名 |
| 非 Paseo 环境 | `basename(cwd)`（与现有 settled 提示一致） |
| `cwd` 在 `$PASEO_HOME/worktrees/<hash>/<slug>` | `<slug>` |

截断：resolver 默认 `maxLen = 40`（够放下「项目 · 中文标题」，TUI 面板不再二次截断）；
弹窗侧再按「workspace ≤ 40 / 合成标题 ≤ 50」收紧（pinotify 浮窗宽 348px、标题单行 `truncatingTail`，见
`personal/notify/pinotify.swift:150-160`）。

## 3. 改动清单

### 3.1 新模块 `packages/core/workspace/index.ts`（纯 Node，零 pi 依赖）

```ts
export interface WorkspaceInfo {
  label: string;                 // 展示用，已截断
  labelFull: string;             // 未截断
  project?: string; title?: string; branch?: string; kind?: string;
  source: 'paseo' | 'worktree' | 'path';
}
export function resolveWorkspace(cwd: string, env?: NodeJS.ProcessEnv): WorkspaceInfo;
export function resolveWorkspaceLabel(cwd: string, env?: NodeJS.ProcessEnv, maxLen?: number): string;
export function resetWorkspaceCache(): void;   // 测试缝
```

- 只用 `node:fs` / `node:path` / `node:os`；**永不抛**（全部 try/catch + `ENOENT`/坏 JSON 回落）。
- 文件缓存按 `mtimeMs + size` 判定失效（Paseo 改 workspace 名后下次调用即生效，无需重启 pi）。
- 不在模块顶层读文件（避免 pi 启动期 IO）；首次调用才读。

### 3.2 `AttentionRequest` 增加可选 `workspace`

`packages/core/attention/index.ts`：加 `workspace?: string`（保持向后兼容，缺省 undefined 时行为完全不变）。
四处 emit 补传（都用各自的 `ctx.cwd`，permission 用 `policyCtx.cwd`）：

1. `packages/core/permission/index.ts:157`（ask 分支）
2. `packages/core/permission/index.ts:274`（超时放行）
3. `ask/index.ts:205`（ask_user_question）
4. `packages/core/plan/tools.ts:117,152`（计划待审批 / 超时自动批准）

### 3.3 `personal/extensions/notify.ts` 渲染

```ts
const ws = String(req.workspace ?? "");
const title = ws ? `${req.title} · ${ws}` : req.title;   // 无 workspace 时行为不变
// composeAttentionTitle()：ws ≤ 40、合成标题 ≤ 50（浮窗单行宽）
popup(style.popup, composeAttentionTitle(req), body);
```
- `agent_settled` 分支改为同一 resolver（`import { resolveWorkspace } from "../../packages/core/workspace/index.ts"`
  包在 try/catch 里，失败回落现有 `basename(ctx.cwd)`）→ 授权提示与落定提示用同一套命名。
- 不变量保持：`PI_NOTIFY=0` 禁用、headless 静默、fail-open（通知异常绝不影响授权判定）。

### 3.4 TUI 审批面板显示 workspace

`extensions/30-permission.ts`：
- 给审批 `QuestionSpec` 加 `body: \`📍 ${label} · ${cwd}\``（`ask/dialog.ts:514-523` 已支持 dim body 渲染，
  超长自动折叠为 `... N more line(s)`），并顺手去掉问句里重复的 `Approval Required:` 前缀
  （问句改为 `${approvalTitleFor(toolName)}\n${message}`，去掉重复的 `Approval Required:`）。
- RPC 路径 `approvalViaRpcUi(...)` 的 title 传入时拼上 ` · ${label}`。
- 超时自动放行的 `announceTimeout` 文案带 label。

### 3.5 文档

`plans/2026-11-02-permission-prompt-workspace-label.md`（本文件归档）+ `CHANGELOG.md` 一条，
并把 `personal/extensions/notify.ts` 头部注释的「不 import repo 代码」说明更新为「不 import pi 宿主 API；
允许 import repo 的纯函数模块，且必须 try/catch 回落」。

## 4. 测试（TDD：先写测试再改实现）

新增 `tests/workspace.test.mjs`（沿用 `tests/permission.test.mjs` 的 jiti 加载套路，注入临时 `PASEO_HOME`）：

1. 命中 `local_checkout`（title=null）→ `pi-lamboy-harness`
2. 命中目录类（title 有意义）→ `policy-optimization · 短文桶驱逐策略优化`
3. 无 `PASEO_WORKSPACE_ID` → `basename(cwd)`
4. `workspaces.json` 缺失 → 回落且不抛
5. 坏 JSON → 回落且不抛
6. workspaceId 不在文件里 → 回落
7. 记录的 `cwd` 与传入 `cwd` 不一致 → 回落（防 pi-subagents worktree 误报父 workspace）
8. worktree 路径 `$PASEO_HOME/worktrees/x/slug` → `slug`
9. 超长标题按 `maxLen` 截断且带省略号
10. 文件 mtime 变化后读到新标题（缓存失效）
11. 同一文件多次调用只读一次（读计数注入或用 mtime 断言，视实现选择）

改 `tests/attention.test.mjs`：
- 测试前清理 `PASEO_WORKSPACE_ID`/`PASEO_HOME`（否则跑在 Paseo 终端里会读到真实文件，污染断言）
- 新增：permission ask 事件的 `workspace` 字段存在且等于注入的假 workspace 名
- 新增：`workspace` 缺省时事件对象不含该键（向后兼容）

`npm test` 全绿 + `npx tsc -p tsconfig.json` 无错。

## 5. 验收（可复现步骤）

1. 在 Paseo 打开两个 workspace（如 `pi-lamboy-harness` 与 `kv-simulator`），各起一个 pi 会话。
2. 在两个会话里各触发一次需要审批的调用（manual 模式下 `bash "touch /tmp/x"`）。
3. 期望弹窗标题分别为 `🔐 需要授权 · pi-lamboy-harness`、`🔐 需要授权 · kv-simulator`；
   TUI 面板问句下方显示 `📍 <workspace> · <cwd>`。
4. 在普通终端（无 `PASEO_*`）起 pi 触发同类审批：标题回落 `🔐 需要授权 · <目录名>`，无异常。
5. 回归：`PI_NOTIFY=0` 时静默；RPC 模式（`ctx.mode !== "tui"`）不弹桌面通知。

## 6. 不做的事

- 不改破坏性命令的判定逻辑、不改 session 审批记忆、不改超时时长
- 不引入 Paseo daemon 依赖（不调 `/api/*`、不 spawn `paseo` CLI）
- 不在系统提示里注入 workspace 名（会污染前缀缓存，`packages/core/permission/index.ts:369-380` 的设计前提）

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| `~/.paseo/projects/*.json` 是 Paseo 私有格式，升级可能变形 | 全部 try/catch + 回落路径名；测试 #4/#5/#6 锁定 degrade 行为；不影响任何授权决策 |
| pi-subagents 子代理带 worktree cwd 但继承父进程 `PASEO_WORKSPACE_ID` | 校验 `record.cwd === cwd`（含 `isUnder` 判断），不匹配即回落；测试 #7 |
| `notify.ts` 开始 import repo 模块，repo 改动可能拖崩通知 | 纯函数模块 + try/catch 回落 `basename(cwd)`；保留 `PI_NOTIFY=0` 一键禁用 |
| 标题过长撑破浮窗 | resolver 默认 `maxLen=40`（按码点切，不劈开代理对），notify 合成标题 ≤ 50；浮窗本身 `truncatingTail` |
| 同一 workspace 内多 agent 并发（同 cwd）仍无法区分 | 本次不做（`PASEO_AGENT_ID` 当前未注入，实测 env 无该变量）；如需再加 agent/terminal 短 id |

## 8. 备选方案

- **B. 轻量版**：只把 `basename(cwd)` 塞进 attention（不读 Paseo JSON）——15 行改动、零私有格式依赖，
  但同一项目多个 worktree 时仍靠 slug 分辨、看不到用户在 Paseo UI 里起的标题。
- **C. 方案 A + 底部状态栏常显**：额外在 TUI footer 常显当前 workspace（`setStatus("workspace", …)`），
  随时可见而不是只在审批时可见；多一处 UI 噪音。

## 9. 实施记录（reviewer 复核后定稿）

reviewer 复核结论：无 BLOCKER，可合入；以下发现已在本轮全部落实。

- **S1**：`personal/extensions/notify.ts` 头注释的「不 import repo 代码」已改为实际契约——
  「不 import pi 宿主 API；唯一允许的 repo 依赖是 `packages/core/workspace` 这类纯函数模块，
  且调用处必须 try/catch 回落路径名」。
- **S2**：`kind === 'worktree'`（或记录 cwd 落在 `<PASEO_HOME>/worktrees` 下）且没有可用 title 时，
  标签追加 worktree slug（`pi-lamboy-harness · verify-wt-setup`），避免与同项目主 checkout 同名。
  新增 fixture 用例覆盖。
- **S3**：补齐「`workspace` 缺省时事件对象不含该键」的断言，并把弹窗标题拼装抽成纯函数
  `composeAttentionTitle()` 直接断言（含浮窗宽度上限），不再依赖 spawn 的子进程。
- **N1**：本文档数字已与实现对齐（maxLen 40、标题上限 50、问句换行格式）。
- **N2**：`clamp()` 按码点切片，避免 emoji/代理对断裂。
- **N3**：`archivedAt` 判定改为「非空即归档」，兼容未来写 epoch 数字的格式。
- **N4**：RPC 标题与 TUI 对齐为 `${actionTitle} · ${workspace}\n${title}`。
- **N5**：`agent_settled` 在 `ctx.cwd` 缺失时保持旧行为（裸 `pi`），不再退化成 `process.cwd()`。

最终验证：`node tests/workspace.test.mjs` 26 项、`node tests/attention.test.mjs` 53 项，
`npm test` 全绿（29 套件），`npx tsc -p tsconfig.json` 退出码 0。
