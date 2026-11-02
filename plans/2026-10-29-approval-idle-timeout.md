# 无人操作超时自动放行（approval idle timeout）

**日期**：2026-10-29
**问题**：yolo 模式下 destructive / 敏感文件 / .git 仍会弹授权面板（这是有意的守卫），但人不在屏幕前时会一直卡住，agent 停摆。
**目标**：人不在时，阻塞面板等够时间就自动推进；人回来能看到"发生过什么"，模型也知道"这次没被人工复核"。

## 0. 已确认决策（2026-10-29 用户选择）

1. **覆盖 destructive**，但阈值更长：普通 ask / 计划审批 / 提问 = 5 min，destructive = 15 min。
2. **覆盖三类面板**：权限授权面板、`exit_plan_mode` 计划审批面板、`ask_user_question` 提问。
3. **生效模式**：`yolo` + `auto`（`manual` 不受影响，保持"必须有人"）。
4. **放行语义**：Allow once（不写会话记忆）+ attention 通知 + 模型上下文尾部注入一次「超时自动放行，未经人工复核」。

## 1. 现状证据

| 事实 | 证据 |
|---|---|
| yolo 下仍会 `ask` 的只有 4 个策略出口 | `packages/core/permission/policies.ts:100`（destructive）、`:152`（user ask）、`:213`（敏感文件）、`:246`（.git 路径） |
| 授权面板自己渲染，**不受** pi 内置 timeout 覆盖 | `extensions/30-permission.ts:46` → `ask/index.ts:34` `ctx.ui.custom`；pi 的 `timeout/signal` 只声明在 `select/confirm/input` 上（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:36-42`） |
| 计划审批用 `ctx.ui.select`，超时与 Esc 都返回 `undefined`，无法区分 | `packages/core/plan/tools.ts:186/220/245/268`（`{timeout:600000}`），`undefined` → `handleReviewCancelled()`（`:125`） |
| 提问工具无超时 | `ask/index.ts:186` `showQuestionsDialog(ctx, questions)` |
| 已有一条"用户被阻塞"的跨扩展通知通道 | `packages/core/attention/index.ts` `emitAttention()`（`kind: ask/approval/plan`） |
| 模型侧注入走 context 事件的尾部 user 消息 | `packages/core/permission/index.ts:243` `injectIntoMessages` |

**结论**：三类面板都得我们自己控制，不能靠 pi 内置 `timeout`（`custom` 没有该选项，`select` 的 timeout 与 Esc 不可区分）。

## 2. 配置契约

`~/.pi/agent/permissions.json`（或项目 `.pi/permissions.json`）：

```json
{
  "defaultMode": "yolo",
  "approvalTimeout": {
    "enabled": true,
    "modes": ["yolo", "auto"],
    "defaultMs": 300000,
    "destructiveMs": 900000
  }
}
```

- 环境变量覆盖：`PI_APPROVAL_TIMEOUT_MS`（0 = 关闭）、`PI_DESTRUCTIVE_TIMEOUT_MS`。
- 运行时覆盖：`/mode timeout 5m` / `/mode timeout 90s` / `/mode timeout off` / `/mode timeout reset`（会话级，不写盘）。
- 缺省即上表的值 —— 不配置也会生效（用户要的就是默认行为）。

## 3. 设计

### 3.1 新模块 `packages/core/permission/timeout.ts`（纯函数，零 pi 依赖）

- `loadApprovalTimeoutConfig()` → `{ enabled, modes, defaultMs, destructiveMs }`
- `approvalTimeoutFor(target, mode, cfg?)` → `number | undefined`
  - `target`: `'approval' | 'approval-destructive' | 'plan' | 'ask'`
  - 关闭 / 模式不在 `modes` / ms ≤ 0 → `undefined`（= 保持旧行为）
- `setSessionTimeoutOverride(ms | null)` + 容器 `timeoutSessionOverride`（jiti 2.7.0 不能用跨模块 `export let`，与 `permissionModeState` 同款容器写法）
- `runDialogWithTimeout(run, ms, parentSignal)` → `{ value, timedOut }`：自建 `AbortController`，到点 abort 让 `select/confirm/input` 关闭，并用 flag 区分「超时」与「用户 Esc」。
- `formatDuration(ms)` → `5m00s`

### 3.2 授权面板（`ask/dialog.ts` + `ask/index.ts` + `extensions/30-permission.ts` + `permission/index.ts`）

- `QuestionDialogComponent` 新增第 4 个构造参数 `{ timeoutMs?, tui?, countdownLabel? }`：
  - 1s tick 更新底部 `⏰ 4:32 until auto-approve`；`tui.requestRender()` 重绘；到点 `onDone({ timedOut: true })`。
  - `dispose()` 清 interval；`cancel/submit/expire` 都经 `finished` 守卫，避免双完成。
- `showQuestionsDialog(ctx, specs, { timeoutMs })` 透传；新增 `showQuestionDialogOutcome()` 返回 `{ choice?, timedOut, cancelled }`，旧 `showQuestionDialog()` 语义不变（返回 `string | undefined`）。
- `PermissionManager.evaluate`：
  - `timeoutMs = approvalTimeoutFor(isDestructive ? 'approval-destructive' : 'approval', mode)`，作为 `ApprovalDialogFn` 第 5 参传入；
  - 返回 `timedOut` → **continue 后续策略**（不短路 deny 策略），并置 `timedOutAllow` 标记，末尾**跳过** `recordApproval`（Allow once 语义）；
  - `noteTimeout()` 入队一条 notice，`emitAttention({kind:'approval', title:'⏰ 超时自动放行'})` + `ctx.ui.notify`；
  - `injectIntoMessages` 把 notice 一次性 drain 进尾部 user 消息：「以下操作在无人操作超时后自动放行（Allow once，未记入会话记忆）… 请复核结果」。
- RPC / 无 `custom` 宿主：`approvalViaRpcUi(..., { timeoutMs })` 用 3.1 的 `runDialogWithTimeout` 包 `ui.select`（`signal` 由 pi 支持，能真正关掉对话框）；`ctx.ui.confirm` 回退路径同样处理。

### 3.3 计划审批（`packages/core/plan/tools.ts`）

- 有超时配置时：`runDialogWithTimeout(select)`；`timedOut` → **自动批准**（与 auto 模式既有行为一致），notify + attention + 模型侧说明「计划未经人工审阅」；
- 无超时配置时：保持原 `{ timeout: 600000 }` → `handleReviewCancelled()`（计划保留、plan mode 仍在）。
- `Revise` 的 `input` 不变（用户刚交互过，人还在）。

### 3.4 提问工具（`ask/index.ts`）

- `approvalTimeoutFor('ask', permissionManager.getMode())` → `showQuestionsDialog(..., { timeoutMs, countdownLabel: 'until auto-continue' })`；
- `timedOut` → 工具结果文本：「N 分钟无回答，请自行做出合理决定继续推进，并在最终回复标注该决定是无人回答下的自决」+ `details.timedOut = true`。

## 4. 风险与边界

| 风险 | 处置 |
|---|---|
| 无人值守时 `rm -rf` 被放行 | 破坏性阈值 15 min（更长的人工回窗），且**永不写会话记忆**，每次超时都通知 + 告知模型复核 |
| Esc 被误判成超时 | 用自有 `AbortController` + flag：只有计时器触发的 abort 才算超时；用户 Esc 仍是 deny/cancel |
| 定时器泄漏 / 双完成 | `finished` 守卫 + `dispose()` 清 interval；`runDialogWithTimeout` finally 清 timer + 移除 parent abort 监听 |
| 通知/注入干扰流程 | 全部 fail-open（try/catch、attention 已 fail-open） |
| manual 模式被弱化 | 默认 `modes = ["yolo","auto"]`，manual 不生效 |

## 5. 验证

- 新增 `tests/approval-timeout.test.mjs`：配置读取（默认/json/env）、模式与 target 门控、destructive 阈值、`evaluate` 超时放行不写记忆且注入提醒、正常放行仍写记忆、`runDialogWithTimeout` 区分超时/Esc、组件级倒计时到点 `timedOut`。
- `npm test`、`npm run typecheck`。

## 6. 复核（reviewer）与修复

首轮实现后委派 `reviewer` 审 diff，发现 3 个真缺陷，均已修复并补回归用例：

| 级别 | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| blocker B1 | 超时放行仍会写 `sessionApprovals`：超时后 `continue` 会让后续 `approve` 策略（yolo-approve / user-allow / default-approve）走 `recordApproval`，「下次仍要问」失效 | `permission/index.ts` 的 approve 分支原本无条件 record；旧守卫只在链尾 | approve 分支改成 `if (timedOutAllow) { announce; return undefined; }` 再 `recordApproval`；链尾守卫保留。回归用例：yolo + `{"ask":["bash"]}`，两次 `bash echo hi`，断言不落指纹且第二次仍弹面板 |
| major M1 | `ctx.ui.confirm` 回退路径上超时检测不到：pi 的 confirm 在 abort 时 resolve `false`（`dist/modes/interactive/interactive-mode.js:1967-1969` `return result === "Yes"`；RPC 同样默认 false），旧判定 `value === undefined` 永不成立 → 超时被当成「用户拒绝」 | `permission/index.ts` confirm 分支、`approval-rpc.ts` | `runDialogWithTimeout` 增加 `aborted` 字段（计时器是否触发），布尔型对话框用 `aborted && value !== true` 判定；字符串型仍用 `timedOut`（迟到真答案优先于计时器） |
| major M2 | 计划审批改成 `signal` 后，pi 内置倒计时消失，用户完全看不到「到点会自动批准」 | `plan/tools.ts` `selectPlanReview` | select 标题追加 `⏰ 5m00s 无操作 → 自动批准（未经人工审阅）`；RPC 审批 prompt 同样追加 `⏰ … 无操作 → 自动放行（仅本次）` |

另修 6 处 minor：通知改为「真正允许时」才发（后续 deny 策略生效时不误报）；`/mode timeout X` 循环内共用同一 deadline（避免 Deny→reason→返回重开时重置计时）；ask 工具超时保留已答问题（`answersSoFar`）；`details` 统一 `answersEnvelope + timedOut`；`/mode status` 在会话级 0 覆盖时正确显示 off；配置读取尊重 `modes: []`（= 无模式生效）、按 cwd 读项目配置、`actionDetail` 惰性计算 + JSON 失败兜底；提交页也渲染倒计时；`formatCountdown` 支持 ≥1h。

未改的已知项：Revise 的 `input` 不做超时（用户刚交互过，人还在）；`showQuestionDialog()` 保留为兼容导出；notice 去重用 5s 窗口而非指纹（重复提醒最多噪一次）。

