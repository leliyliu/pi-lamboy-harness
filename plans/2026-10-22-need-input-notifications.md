# 需要用户介入时的通知（ask / 授权 / 计划审批）

**日期**：2026-10-22
**问题**：现有通知只在 `agent_settled`（turn 结束）时弹；`ask_user_question` 和权限授权对话框出现时没有任何提醒，人离开屏幕就卡在那里。
**结论**：**可以完成**。两个卡点都能在现有代码里找到唯一、无副作用的前置钩子（证据见 §2），不需要改 pi 本体。

## 0. 已确认的决策（2026-10-22 用户选择）

1. **覆盖范围**：提问 + 权限授权 + 计划审批（三类全接）。
2. **提醒方式**：浮窗 + 声音（`Ping` / `Submarine` / `Hero`，与 turn 结束的 `Glass` 区分）。
3. **源码归位**：`~/.pi/agent/extensions/notify.ts` 迁入 `personal/extensions/notify.ts`，home 旧文件改名留档。

---

## 1. 现状

- 通知宿主：`~/.pi/agent/extensions/notify.ts`（v5）→ `pinotify` 自绘浮窗 + `afplay` 声音，绕开被企业策略封锁的 UNUserNotificationCenter。
- 唯一触发点：`agent_settled`（`~/.pi/agent/extensions/notify.ts:139`），正常 = Glass/✅，error = Basso/❌，aborted 静默。
- 声音/浮窗通道均已实测可用（`plans/2026-10-22-提醒服务实测与多屏修复.md` §2）。

## 2. 可行性证据（代码位置）

| # | 需求点 | 钩子位置 | 证据 |
|---|---|---|---|
| 1 | `ask_user_question` 对话框弹出前 | `ask/index.ts:168-176`（`execute()` 内、`showQuestionsDialog` 之前） | 工具由 `registerAskUserQuestion`（`ask/index.ts:126`）注册；`showQuestionsDialog` 在 `ask/index.ts:33-45` 才真正 `ctx.ui.custom` 建面板 |
| 2 | 权限授权面板弹出前（TUI） | `extensions/30-permission.ts:46`（`await showQuestionDialog(...)` 之前） | 审批对话框由该适配器注入（`30-permission.ts:24` `setApprovalDialog`） |
| 3 | 权限授权（通用/RPC 回退） | `packages/core/permission/index.ts:112`（`approvalDialog(...)` 之前）、`:124`（`ctx.ui.confirm` 之前） | 这是 policy chain 里 `result.kind === 'ask'` 的两个出口 |
| 4 | 计划审批（可选纳入） | `packages/core/plan/tools.ts:174` 与 `:228`（两处 `ctx.ui.select` 之前） | 有 alternatives / 无 alternatives 两条审批路径 |
| 5 | 跨扩展传递信号可行 | `pi.events`（EventBus，`ATTENTION_CHANNEL = "lamboy:attention"`） | 类型声明 `dist/core/extensions/types.d.ts:1031`（`events: EventBus`）；实现 `dist/core/event-bus.js` 对 handler 包 try/catch（fail-open）；loader 每个扩展入口独立 jiti 实例（`moduleCache: false`），故不能用模块级注册表 |
| 6 | 不污染其他平台/非 TUI | 通知侧统一判 `ctx.mode !== "tui"` 静默 | 现有 `notify.ts:141` 同款判断；`PI_NOTIFY=0` 已有总开关 |

## 3. 设计（推荐方案）

### 3.1 解耦：repo 只发"注意力事件"，personal 侧负责弹窗

```
repo (packages/core/attention)                 personal (notify 扩展)
  emitAttention({kind, title, body})  ──▶  pi.events "lamboy:attention"  ──▶  浮窗 + afplay
  （入口先 setAttentionBus(pi.events)）
```

- **repo 侧零平台依赖**：`emitAttention()` 只做「有 bus 就发，没 bind 就 no-op」，默认静默。公开包不给 macOS 用户强加弹窗。
- **personal 侧零 repo import**：只订阅 `pi.events` 的 `lamboy:attention` 频道，避免跨包相对导入在 bundle 时的解析风险。
- **fail-open**：`pi.events` 的 handler 被 EventBus 包 try/catch，`emitAttention` 自身也整体 try/catch，通知永远不能阻断授权/提问流程。

### 3.2 接入点（每处一次，不重复）

| 场景 | 接入位置 | 事件 payload |
|---|---|---|
| 提问 | `ask/index.ts` `execute()`，在 `showQuestionsDialog` 之前（仅 `ctx.hasUI`） | `kind:"ask"`, `title:"❓ 需要你回答"`, `body: 第一问文本（截断 120）` |
| 权限授权 | `packages/core/permission/index.ts`，`approvalDialog` / `ctx.ui.confirm` 之前 | `kind:"approval"`, `title:"🔐 需要授权"`, `body:` `<toolName>: <message>` |
| 计划审批 | `packages/core/plan/tools.ts` 两处 `ctx.ui.select` 之前（:174、:228） | `kind:"plan"`, `title:"📋 计划待审批"`, `body: 计划文件路径/前 120 字` |

> 注意：**不要**把钩子放进 `showQuestionsDialog()` 内部——它被权限审批复用（`30-permission.ts:46`），放进去会和 §3.2 权限钩子重复弹两次。

### 3.3 通知矩阵（声音沿用已验证通道）

| 事件 | 浮窗 kind | 音色 | 文案 |
|---|---|---|---|
| `ask` | info | `Ping` | `❓ 需要你回答的问题 · <问题摘要>` |
| `approval` | info | `Submarine` | `🔐 需要授权 · <tool>: <原因摘要>` |
| `plan` | info | `Hero` | `📋 计划待审批 · <项目名>` |
| `settled`（现状不变） | success/error | Glass/Basso | `✅ 完成 / ❌ 出错` |
| `aborted` | — | 静默 | 现状不变 |

音色可被环境变量覆盖（如 `PI_NOTIFY_SOUND_ASK`），默认值写死即可，不引入配置面。

### 3.4 去重与边界

- 同 **kind** 800ms 内的重复事件合并（同一 kind 只响一次声音；不同 kind 互不影响，仍各自提醒）。
  实测依据：2026-10-22 E2E（§9）三种 kind 在同一 10ms 内连续发，三个浮窗 + 三次声音全部到达，符合本设计。
- `ctx.mode !== "tui"` → 全静默（headless/RPC 不弹窗、不响铃）。
- `PI_NOTIFY=0` → 全禁用。
- 用户主动按 Esc 中止的 turn 仍不提醒（现状）。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/attention/index.ts`（新增，~110 行） | `ATTENTION_CHANNEL`、`ATTENTION_DEDUPE_MS`、`setAttentionBus(bus)`、`emitAttention(req)`、`resetAttentionState()`（测试 seam） |
| `ask/index.ts` | `execute()` 内、建面板前 `emitAttention` |
| `packages/core/permission/index.ts` | 两个 `ask` 出口前 `emitAttention`（带 `ctx`，不改变任何决策逻辑） |
| `packages/core/plan/tools.ts` | 两处审批 select 前 `emitAttention`（:174、:228） |
| `personal/extensions/notify.ts`（新增，从 `~/.pi/agent/extensions/notify.ts` 迁入） | 保留 settled 逻辑 + `pinotify/afplay` 发送器 + 订阅 `pi.events` 的 `lamboy:attention` 频道 |
| `personal/README.md` | 内容清单补一行 notify 扩展 |
| `tests/attention.test.mjs`（新增） | 见 §5 |

部署动作（实施后一次性）：
1. `mv ~/.pi/agent/extensions/notify.ts ~/.pi/agent/extensions/notify.ts.bak-<ts>`（避免 personal 包中新扩展与 home 旧文件双注册、双弹窗）；
2. 重启 pi（扩展代码在启动时载入，不热更——证据见 `plans/2026-10-22-提醒服务实测与多屏修复.md` §3）。

## 5. 测试（TDD，先写后实现）

`tests/attention.test.mjs`（纯 node，沿用 `tests/permission.test.mjs` 的 TS 加载器）：

1. 未注册 notifier → `emitAttention()` 不抛错、静默返回；
2. 注册后 → 收到一次、payload 字段完整（kind/title/body）；
3. 回调抛错 → `emitAttention` 不抛（fail-open），后续事件仍能送达；
4. 800ms 去重：同 kind 连续两次 → notifier 只收到一次；不同 kind → 都收到；
5. `tests/permission.test.mjs` 增补：`ask` 分支走到对话框前一定发出一次 attention（用 fake ctx + fake approvalDialog）；
6. `tests/ask.test.mjs` 增补：`execute()` 在有 UI 时发一次、无 UI（`hasUI=false`）时零次。

命令：`npm test`（`tests/run-all.mjs` 自动收录新文件）+ `npm run typecheck`。

## 6. 验收（人工）

重启 pi 后：

| 步骤 | 期望 |
|---|---|
| 让 agent 调 `ask_user_question` | 右上角浮窗「❓ 需要你回答…」+ Ping |
| `manual` 模式下让 agent 跑一个高危 bash | 浮窗「🔐 需要授权…」+ Submarine，且**在对话框出现的同时**弹出 |
| 普通 turn 结束 | 仍只有「✅ 完成」（不重复、不多弹） |
| `PI_NOTIFY=0 pi ...` | 三种事件全部静默 |
| 管道/headless 跑 `pi -p ...` | 零浮窗、零声音；`/tmp/pi-notify.log` 默认无新增（加载横幅仅在设置 `PI_NOTIFY_DEBUG` 时写） |

## 7. 风险与取舍

| 风险 | 处置 |
|---|---|
| 通知与对话框出现在同一瞬间，可能被对话框抢焦点 | pinotify 是 `.nonactivatingPanel`（不抢焦点），浮窗在屏幕层 25，实测可见 |
| 连续多次授权 → 通知轰炸 | 800ms 去重 + 每种 kind 独立 |
| 移动 home `notify.ts` 后旧会话仍跑旧代码 | 明确要求重启；旧文件改名留档 |
| personal 扩展未被加载（安装路径变化） | 验收时先确认浮窗出现；`PI_NOTIFY_DEBUG` 日志带 pid 可定位 |
| repo 公开包不希望默认弹窗 | 默认无 notifier 时 no-op，纯 no-op 行为不改变现有语义 |

## 8. 交付顺序

1. **Step 1**：`attention` 事件层 + 测试（TDD：先写 `tests/attention.test.mjs`）。
2. **Step 2**：三处接入（ask / permission / plan）+ 对应测试增补。
3. **Step 3**：`personal/extensions/notify.ts`（含 `pi.events` 订阅与三种音色）+ README 更新；home 旧文件改名留档。
4. **Step 4**：`npm test` + `npm run typecheck` 全绿；重启 pi 后按 §6 人工验收。
5. **可选后续**：改 `pinotify.swift` 增加 `question`/`warning` kind 图标（需 `swiftc` 重建），不影响本轮功能。

---

## 9. 实施记录（2026-10-22）

已按计划完成 Step 1-4 的代码与自动化验证部分：

| 项 | 结果 | 证据 |
|---|---|---|
| attention 事件层 | 新增 `packages/core/attention/index.ts`（`ATTENTION_CHANNEL="lamboy:attention"` / `setAttentionBus` / `emitAttention` / `resetAttentionState`、`ATTENTION_DEDUPE_MS=800`）；传输走 `pi.events`（`dist/core/extensions/types.d.ts:1031` 声明 `events: EventBus`），因为每个扩展入口是独立 jiti 实例（`loader.js:358` `moduleCache: false`），模块级注册表跨 bundle 不共享 | `tests/attention.test.mjs` 45 项断言 |
| ask 接入 | `ask/index.ts` 在 `showQuestionsDialog` 之前 emit（仅 `hasUI`） | `tests/attention.test.mjs` §8 两条 |
| permission 接入 | `packages/core/permission/index.ts` 在 `approvalDialog` 分之前 emit（no-UI / 声明式 deny 不触发） | `tests/attention.test.mjs` §7 六条 |
| plan 接入 | `packages/core/plan/tools.ts` 两处审批 `select` 前 emit，auto 模式不触发 | `tests/attention.test.mjs` §9 三条 |
| 通知扩展迁移 | 新增 `personal/extensions/notify.ts`（v6：settled + `pi.events` 订阅，Ping/Submarine/Hero） | 文件存在；已纳入 `tsconfig` 类型检查 |
| 测试 / 类型 | `npm test` → all suites passed；`npm run typecheck` → 退出码 0 | 命令输出 |
| home 旧文件 | `~/.pi/agent/extensions/notify.ts` → `notify.ts.bak-20261022-v6` | `ls` 输出 |

**人工验收：通过（2026-10-22 23:30，运行中的 TUI 会话 pid 48964）**。按 §6 表格逐项确认结果：

| 步骤 | 结果 | 证据 |
|---|---|---|
| agent 调 `ask_user_question` | ✅ 浮窗 + Ping，用户当场确认「浮窗 + 声音都出现了」 | `/tmp/pi-notify.log: [48964] attention kind=ask … → pinotify spawned kind=info → afplay Ping exit=0`（15:30:36Z） |
| 破坏性 bash（`echo 'git reset --hard …'`，仅打印） | ✅ 浮窗 + Submarine，且在审批面板出现同时弹出；选 Allow once 后命令执行 | 同上，`attention kind=approval … → pinotify spawned kind=info → afplay Submarine exit=0`（15:31:12Z） |
| 普通 turn 结束 | ✅ 仍只有「✅ 完成」，未重复 | `afplay Glass exit=0`（settled 分支） |
| 计划审批 | 未在 TUI 手工复现；由 `tests/attention.test.mjs` §9 + E2E §9.1 覆盖同一通道 | 同 ask/approval 通道 |
| `PI_NOTIFY=0` / headless | 由单元测试覆盖（`DISABLED` 早退、`ctx.mode !== "tui"` 静默） | `tests/attention.test.mjs` mode gate 三条 |

### 9.1 真实进程 E2E（2026-10-22 23:26，macOS）

单元测试只证明“我们的模块逻辑对”，不证明“pi 真的把事件从 emit 入口送到 notify 扩展”。为此用真实 `pi` 进程（隔离加载，不碰当前会话）做了链路烟测：

```bash
# /tmp/pi-attn-e2e/probe.ts：import repo 的 attention 模块，
# setAttentionBus(pi.events)，在 session_start 里连发 ask/approval/plan 三种事件（mode:"tui"）
PI_NOTIFY_DEBUG=/tmp/pi-attn-e2e/notify.log \
  pi -ne -e <repo>/personal/extensions/notify.ts \
     -e /tmp/pi-attn-e2e/probe.ts --no-tools --offline -p "hi"
```

结果（pid 52426，日志原文）：

```
[15:26:29.786Z] attention kind=ask title=❓ E2E ask body=ask-question 通知链路自测
[15:26:29.788Z] pinotify spawned kind=info
[15:26:29.788Z] attention kind=approval title=🔐 E2E approval body=allow 授权通知链路自测
[15:26:29.791Z] pinotify spawned kind=info
[15:26:29.791Z] attention kind=plan title=📋 E2E plan body=plan review 通知链路自测
[15:26:29.793Z] pinotify spawned kind=info
[15:26:32.222Z] afplay Ping exit=0
[15:26:32.217Z] afplay Submarine exit=0
[15:26:31.188Z] afplay Hero exit=0
```

结论：`repo emitAttention → pi.events → notify 订阅 → pinotify 浮窗 + afplay` 在真实 pi 加载器下全链跑通（三事件三浮窗三声音，无丢失、无 dedupe 误伤）。

**仍未自动化的部分**：TUI 会话里由真实工具调用（而非 probe）触发的事件——即 §6 的人工验收表。

**已知边界**：去重状态按 kind 存放在事件层模块内；pi 按扩展入口分别 bundle，因此同一 kind 的去重只在其所属扩展内生效——由于 kind 与扩展一一对应（ask→50-ask、approval→30-permission、plan→20-plan），实际不会出现跨 bundle 漏去重。
