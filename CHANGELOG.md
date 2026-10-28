# Changelog

All notable changes to pi-lamboy-harness, in reverse chronological order.

## Unreleased

- Fixed (goal, handoff): 预算不再需要人工介入、95% 档不再催 handoff、handoff 后新会话自动续跑（用户反馈 2026-10-28：「遇到预算不足应该自动加预算，并且减少 /handoff；handoff 之后还需要优化」；决策与证据 `plans/2026-10-28-budget-autotopup-less-handoff-autocontinue.md`）。根因是两个策略互相打架：2026-10-26 的 auto-renew 只在**撞墙那一 turn** 触发，而 2026-10-19 的 handoff-first 文案还在指挥模型「≥95% 立即调 handoff 写 briefing」「budget_limited 第 1 步 call the handoff tool NOW」，并且跨进程/跨会话恢复的 `budget_limited` 没有任何再入点；真实 session 数据可证：`g-mvpcho72-7amv` 在 93.5%（2,326,708/2,487,489）被人工抬额到 3M，`g-mvovhm7h-k14g` 停在 `budget_limited` 靠 `/goal resume` 恢复。修复：① **C1 提前量自动扩预算**——`recordTurn`/`recordTokenUsage` 在跨限判定**之前**按告警档（`PI_LAMBOY_GOAL_TOPUP_AT`，默认 80%，0 关闭）先扩，公式与撞限续接一致 max(used+800k, ceil(used×1.25/50k)×50k)，共用 `autoRenewMax`/8M 上限，turn/wall-clock 同时越界时不消耗续接次数，返回值新增 `autoRenewed.reason`（headroom/crossing）供 UI 区分；② **C2 budget_limited 自动复活**——新增 `autoRecoverBudget()`（token-only、忽略 turn/wall 越界、幂等、受同一上限），在 `session_start` 与每次 `context` 事件（`extensions/40-goal.ts`）调用，修复「跨会话恢复出来的 budget_limited 永远卡住」，`update_goal(status="active")` 对 budget_limited 也从 no-op 改为触发同一恢复；③ **C3 wrap-up 去 handoff 化**——`buildBudgetLimitedWrapUp` 删除 `Call the handoff tool NOW`/`Do NOT continue goal work inline`/`/handoff 一键续接`，改为说明「handoff 不增加预算（预算跟随 goal）→ 2-3 行状态汇报 → 用户用 set_goal_budget 解封，预算覆盖后 runtime 自动 resume」，工具门 reason 同步；④ **C4 档位文案**——≥80% 改为「继续干 + runtime 会自动加预算 + 优先委派」，≥95% 改为「继续干，不要为预算调 handoff/写 briefing」；⑤ **C5 handoff 后自动续跑**——新增 `packages/core/handoff/switch.ts:deliverHandoffBriefing()`，`withSession` 里把审阅后的 briefing 直接 `sendUserMessage` 成新会话首条消息（失败回落 setEditorText），env `PI_LAMBOY_HANDOFF_AUTOSUBMIT=0` 退回旧「预填 + 等回车」。验证：`npm test` 全绿（goal 135、goal-autorenew 49、handoff 55、新增 handoff-autosubmit 10）、`npx tsc -p tsconfig.json` 零错误；新增用例覆盖 79/80% 分界、reason 标记、TOPUP_AT=0、8M 触顶停止、turn 双越界不预扩、budget_limited 复活/不可复活矩阵、自动提交与回落。
- Added (goal): 预算耗尽自动续接 + handoff 预算联动（决策记录 `plans/2026-10-26-goal-budget-auto-renew-and-handoff.md`）。背景：历史 126 个 goal 中 `autoExtend=true` 为 0，`topUps>0` 仅 7 个；budget_limited 的 12 个 goal 全部停在原地；且 `/handoff` 走 `ctx.newSession({parentSession})` 只新建空 session（`session-manager.js:645-670` 仅写 header），而 goal 是进程级单例（无 `session_shutdown` 清理），新 session 首 turn 仍被 wrap-up/`tool_call` 门拦住——这就是「handoff 类似 fork 但不扩展预算」的根因。修复：① **auto-renew**（默认开）——纯 token 越界时 `tokenBudget = min(max(used+800k, ceil(used×1.25/50k)×50k), 8M)`，保持 active，最多 10 次（env `PI_LAMBOY_GOAL_AUTORENEW=0` 关闭；`PI_LAMBOY_GOAL_AUTORENEW_MAX`、`PI_LAMBOY_GOAL_MAX_TOKENS`、`PI_LAMBOY_GOAL_RENEW_STEP` 调整），turn/wall-clock 越界与旧 `autoExtend` 路径（仍用 topUps、+500k）语义不变，autoExtend 的 topUp 用满后由 auto-renew 接手；计数器 `autoRenewals` 独立于 `topUps` 并单调持久化；② **handoff 联动**——`ctx.newSession({ setup })` 中调用 `goalManager.renewForHandoff(sm.appendCustomEntry)`：+800k（同公式、受 8M 上限、不消耗 auto-renew 次数），budget_limited 且预算确实扩展时恢复 active，turn/wall-clock 耗尽不恢复；goal entry 立即写入新 session（旧 `pi.appendEntry` 在 stale 扩展 ctx 上会抛错并被 goal 的 try/catch 静默吞掉，写入丢失），修复「handoff 后重启丢 goal」；env `PI_LAMBOY_HANDOFF_GOAL_RENEW=0` 关闭。验证：新增 `tests/goal-autorenew.test.mjs`（默认续接/关闭/次数上限/8M 上限/turn 与双越界不续接/autoExtend 互斥与 fall-through/委派记账/单调合并）与 `tests/handoff-goal-renew.test.mjs`（扩容+恢复+落盘/关闭/complete no-op/总上限不扩容/active 扩容/turn 耗尽不恢复），旧 §17/§20 与 goal-wiring A2c-A2d 显式 `PI_LAMBOY_GOAL_AUTORENEW=0` 隔离旧语义；`npm test` 全绿、`npm run typecheck` 零错。

- Added (goal): 委派加速与预算耗尽自动续接（spec `plans/2026-10-19-goal-delegation-and-budget-continuation.md`，D1-D5 全按推荐落地）。两个病灶同源：goal 执行中无任何委派信号（subagent 工具描述 pinned 且保守、goal 注入只有 objective+预算数字）→ 父会话内联干活 → 父上下文膨胀 → input 记账指数增长 → 预算频繁耗尽；耗尽后注入文案禁止一切工具（含 handoff）、`shouldBlockTool` 定义但从未接线（软文案）、`/goal resume` 只改状态不动预算 → 下一 turn 立即再超限（resume 陷阱）。方向 A（委派）：A1 active goal 每轮注入预授权委派指引段（env `PI_LAMBOY_GOAL_DELEGATION=0` 关）；A2 turn_end 从 `event.toolResults[].usage` 把 subagent child tokens 经 recordTokenUsage 记入预算（不加 turnsUsed，TurnEndEvent.toolResults，pi types.d.ts:832；async/detached child 不回流 usage 属上游限制，spec §7 注明）；A3 预算档位注入——≥80% 偏好委派、≥95% 立即调 handoff 工具落盘 briefing（阈值 env `PI_LAMBOY_GOAL_BUDGET_WARN`/`_CRIT`，0 关闭）；A4 create_goal guidelines 补委派条目。方向 B（续接）：B1 budget_limited wrap-up 重写为「立即调 handoff 写完整 briefing（objective/criterion/剩余工作/建议预算）→ 2-3 行小结」，衔接现有 /handoff 一键流程（usage_limited 自愈路径不动）；B2 tool_call 硬拦截接线（白名单 get_goal/handoff/update_goal 单源常量 `GOAL_LIMITED_ALLOWED_TOOLS`，env `PI_LAMBOY_GOAL_TOOL_GATE=0` 关）；B3 `/goal resume` 对超限 goal 自动 top-up：max(tokensUsed+500k, ceil(tokensUsed×1.25/50k)×50k)，默认上限 3 次（env `PI_LAMBOY_GOAL_TOPUP_MAX`，0 不限），达上限仍 resume 但预算不动；LLM 路径 update_goal(active) 对 budget_limited 仍 no-op（10b 语义保留）；B4 create_goal 新增 `autoExtend` 参数（默认关）：开启时 token 跨越自动 +500k 续期（env `PI_LAMBOY_GOAL_EXTEND_STEP`）而非 budget_limited，同 top-up 上限保护，双跨越（token+turn/wallClock）不消耗 top-up。顺带修复：create_goal criterion 读取兼容双名（schema 声明的 snake_case `completion_criterion` 与遗留 camelCase，未提交 policy 改写曾致 criterion 被丢、verified=true 门禁被旁路）；recordTurn 重写后无 autoExtend 时逐分支与旧代码等价（reviewer 复核确认）。验证：tests/goal.test.mjs §14-§21（+14 节共 58 新检查：档位四点边界/wrap-up 文案/白名单矩阵/top-up 公式与上限/paused 不碰预算/autoExtend 默认关+续期+上限+步长+双跨越/委派注入开关/文档声明），新增 tests/goal-wiring.test.mjs（真实入口+stub pi：B2 gate 拦截矩阵+env 开关、A2 toolResults 记账含 A2d msg-先跨限盲区）；goal 127 passed / wiring 16 passed / 429-recovery 10 passed / typecheck 零错 / 全套件 all green；reviewer 审查无 blocker/major（Finding 1/2/3 + nit 5/6/7/8 均已修）。
- Added (goal): token budget policy — `create_goal` / `set_goal_budget` 工具层强制大预算（2026-09-29 用户指令：「预算不能这么小，给到 500k 甚至 800k」；方案确认：默认 800k + 强制抬升 500k 下限）。模型自选小预算的根因是工具描述无数值规范（budgetLimits 只写 "Budget limits for the goal"，无任何数值指引），双修复：① 工具层硬策略——未传 tokenBudget 自动填 800000，传入值低于 500000 自动抬升，`set_goal_budget` 同样执行下限（防绕过）但不注入默认（设 turns/ms 预算不得偷偷加 token 预算）；② 文案层——工具 description + promptGuidelines 写入数值规范（注入系统提示，模型在工具层直接可见）。策略仅在模型路径（工具 execute）生效：核心 `createGoal()` 与用户侧 `/goal create`、`/goal budget`、队列 enqueue 原样透传，用户是最高决策者。环境变量：`PI_LAMBOY_GOAL_TOKEN_BUDGET`（默认值 800000）、`PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET`（下限 500000，设 0 分别关闭）。全局 `~/.pi/agent/AGENTS.md` 新增「Goal 预算规范（重要）」章节 + multiloop 开局步骤具体化 500k-800k。设计记录：plans/2026-09-29-goal-token-budget-policy.md。验证：TDD 先行，tests/goal.test.mjs §13 新增 10 检查（默认填充 / 下限抬升 / env 覆盖与关闭 / set_goal_budget 抬升与不注入 / 文档一致性×2 / 核心路径透传×2），goal 套件 63/63 绿，typecheck 零错误，全套件 all green。
- Fixed (goal): 429 usage_limited 卡死事故修复（quant02 2026-09-16，session `2026-09-16T02-40-50-415Z`）——`9f58ba2` 补上 update_goal 的 usage_limited→resume 路由后，现场依旧卡死：注入文案“Tool calls are blocked while the rate-limit window is active”被 GLM-5.3 解读为包括 update_goal 在内的一切工具被阻塞，且“once the window clears”是模型内部不可观测的条件（限流窗恢复没有事件通知它）→ 06:02–06:07 五轮用户催促、甚至原样贴出 `update_goal(status="active")`，模型 thinking 均引述旧文案拒绝执行；`shouldBlockTool` 是死代码（无 tool_call 接线），“工具被阻塞”本就是谎言。双修复：① `buildWrapUpInjection` usage_limited 文案改为恢复教学——“能生成本回复＝限流窗已过”（活跃 429 会令生成本身失败）+ 立即调用 update_goal(status="active") + 明示 get_goal/update_goal 始终可用；② `extensions/40-goal.ts` turn_end 自愈：健康 assistant turn（stopReason 非 error）意味着 provider 恢复服务，自动 resume（budget_limited 不自愈，用户保留决策）。顺带：40-goal.ts 目录导入改为显式 `.ts`（与 82/85/96 同模式，native node 可加载，jiti 兼容）。验证：新增 `tests/goal-429-recovery.test.mjs`（真实入口 + stub pi，R1-R4 四组 10 检查：session 恢复 / 注入文案 / 429 检测不回归 / 自愈 + budget_limited 不自愈）+ `tests/goal.test.mjs` 新增 §11 文案 §12 允许名单（48 检查），typecheck 零错误，全套件绿。

- Added (handoff): session handoff extension — `extensions/85-handoff.ts` + `handoff/commands.ts` + `packages/core/handoff/{prompt,guard}.ts`. Transfer context to a new focused session instead of lossy compaction. Trigger structure follows `ogulcancelik/pi-handoff`, execution path follows pi 0.85.1's official handoff example (verified: extension tools get `ExtensionContext` with no `newSession`, `types.d.ts:372` vs command-context `:248-260` — so all session switching stays inside the command handler, no in-band agent hacks). Three triggers: `/handoff <goal>` (one dedicated `modelRegistry.complete` summarization call → editor review → `ctx.newSession({ parentSession })` prefilled); `handoff` tool (the agent writes the full briefing itself, parked as a custom entry that never enters LLM context, turn-end points the user at `/handoff` which reuses the draft without regenerating); context guard at 90% usage (once per session, declining is durable across reloads). Compaction-aware branch slicing (no compaction / `firstKeptEntryId` / `retainedTail`). The new session records the parent and the briefing references the parent JSONL path (`session_query` is not a built-in pi 0.85.x tool — verified by grep). Kill switches: `PI_LAMBOY_HANDOFF=0`, `PI_LAMBOY_HANDOFF_GUARD=0`, `PI_LAMBOY_HANDOFF_THRESHOLD`. Verified: `tests/handoff.test.mjs` (slicing, prompt build, guard state), typecheck clean, full suite green, live TUI flow exercised. Design record: plans/2026-09-13-handoff-extension.md.
- Added (sanitize): malformed-toolCall guard — `extensions/82-sanitize.ts` + `packages/core/sanitize/index.ts`. Guards against the 2026-09-13 jdcloud/GLM-5.3 incident (plans/2026-09-13-glm53-jdcloud-1210-error-analysis.md): the model occasionally emitted a toolCall whose `arguments` was a top-level JSON array; pi rejected execution locally but kept the malformed structure in session history, and every later request failed 400/code 1210, dead-locking the session. Three defensive layers (all no-ops on clean traffic, exception-guarded): `message_end` fixes the message at finalization (session file stays clean, tools execute repaired args directly), `context` fixes every outgoing LLM call (also rescues sessions poisoned before install), `before_provider_request` rewrites wire-format payloads (openai-completions JSON-string arguments, anthropic `tool_use.input`, openai-responses `function_call.arguments`). Normalization rules live-tested against the live endpoint: array → first object element, JSON-string → parsed, primitive → `{}`; clean input passes through by reference (zero copy). New `/sanitize-session` command repairs historical session files (backup `.bak-sanitize`, atomic rewrite). Verified: `tests/sanitize.test.mjs` 67 checks (rules, reference-identity, wiring), typecheck clean, all 28 suites green, E2E A/B on the poisoned incident session (no-extension control reproduces the exact 1210; with the extension the session continues normally). settings.json whitelist updated (11 → 12 entries). Known cosmetic: pi headless `-p` echoes a trailing stored errorMessage when a command produces no model output — a "400" line printed after `/sanitize-session` on an error-tailed session is that echo, not a new request.
- Added (solpi): SoL-Pi token-efficiency module — NVlabs/SoL-Pi vendored as a git submodule (`vendor/sol-pi`, pinned `d7ecfc0`, MIT), trimmed to the two local-only mechanisms via new entry `extensions/96-solpi.ts`: Action Fusion (`edit`/`write` gain `then_run`, one round-trip per edit-validate sequence) and ObservationPack (large tool results archived per-session, `obs_recall` paged recall, context projection). Evidence-Preserving Reducer and Online Context Compact deliberately not wired (privacy/overlap with 80-truncation; 0.84.2 API lock). Kill switch `PI_LAMBOY_SOLPI=0`. Verified: upstream suite 139/139 (npm run check in submodule), harness typecheck + 36/36 existing tests + new `tests/solpi-entry.test.mjs` 4/4, and a real pi 0.85.1 `loadExtensions` smoke run (edit/write/obs_recall + context hook registered, zero errors). settings.json whitelist updated (10 → 11 entries). devDep `@earendil-works/pi-agent-core@0.84.2` added for typecheck parity with SoL-Pi's tested baseline.

- Fixed (ask): multi-select Enter now picks the cursor option when nothing is toggled yet — previously Enter with an empty selection silently confirmed the question with no answer, later reported as "skipped by user" (start-my-day bug). `ask/dialog.ts` + `packages/core/ask/types.ts` + `tests/ask-dialog.test.mjs`.

- Reverted (permission): pi-multiloop install guard (`known-tool-conflict-install-deny`, from b1e967b) removed per user decision — command semantics are enforced by the instruction layer (`~/.pi/agent/AGENTS.md` "multiloop 语义" section) instead of a hard code guard: "开启 multiloop" means run the deployed Plan-A toolchain (goal + parallel subagents + bench_run/metric_compare), never an install action. The tool-name collision fact remains (verified fatal pi 0.85.1 exit 1) and is documented there.

- Added (permission): pi-multiloop install guard — `known-tool-conflict-install-deny` policy (id 42, safety layer before auto/yolo approve) denies `pi install … pi-multiloop` and settings.json edits that introduce the package (fatal `get_goal`/`update_goal` tool-name collision with harness Goal, verified pi 0.85.1 exit 1). 7 new checks in `tests/permission.test.mjs` (auto/yolo deny, non-conflicting install passes, settings.json write/edit vectors, ordinary-file pass-through).
- Fixed: `injectIntoMessages` signatures now declare optional `timestamp` (3 files from merged 8b74bcb) — typecheck clean again.

- Fixed (ask): multi-select questions were silently submitted with no answer when the user hit Enter on the option they wanted (single-select muscle memory) — Enter only confirmed the current toggle set, so start-my-day's `multi_select` questions came back as `skipped by user` and, after the last question, `advance()` wrapped back to the unanswered question instead of the submit page. Enter on an empty selection now picks the option under the cursor first (non-empty sets still confirm as-is; Other/Chat rows unchanged). New dialog-level regression suite `tests/ask-dialog.test.mjs` drives the real `QuestionDialogComponent` with raw key sequences (13 checks; 22 suites green, typecheck clean).

## 0.14.0 (2026-09-06)

Multi-entry refactor + minimal-preset infrastructure:

- Refactor: single `index.ts` entry → `extensions/` directory with 10 per-module entries (`10-pause` … `95-latex`). Numeric prefixes pin the tool_call gate order (pause → plan → permission): pi loads directory entries in lexical order and short-circuits on the first block (verified in pi `core/extensions/runner.js`). Behavior unchanged when all 10 entries load (21 suites green, typecheck clean).
- Filterable: any module subset can be enabled via object-form `extensions` filtering in settings.json — the same official mechanism used for third-party packages. Verified end-to-end: 8/10 harness entries loaded, perf/latex absent from the tool surface.
- Added: `presets/` — versioned package-set presets (`minimal.v0.1`, `full.snapshot`) + `switch.mjs` (timestamped backup → atomic packages-array replace → loose-decoration sideline → before/after diff).
- Added: `personal/` optional pi package (JD Cloud gpt-image2 image generation + JoySpace markdown import), superseding the loose `~/.pi/agent` copies (which now live in `~/.pi/agent/disabled/`).
- Known: pi-multiloop quick-goal tools (`get_goal`/`update_goal`) conflict with harness Goal — tool-name conflicts are fatal load errors in pi; never enable both simultaneously (documented in `presets/catalog.md`).

## 0.13.0 (2026-08-14)

Phase 4 per plans/2026-08-14-phase4-latex-design.md:

- Added: latex-toolchain — latex_compile (tectonic backend, structured file:line errors + fix hints), bibtex_check (undefined-citation/unused-entry/duplicate-key), /compile command
- Requires: tectonic (brew install tectonic); graceful "not found" error otherwise

## 0.12.0 (2026-08-14)

Phase 3 per plans/2026-08-14-perf-lab-design.md:

- Added: perf-lab — bench_run (remote GPU benchmark, N-run stats, env snapshot), profile_parse (torch profiler trace → hotspot table), metric_compare (Mann-Whitney significance, improve/regress/noise verdict)
- Results persist to `.perf/<run-id>.json` for pi-multiloop verify-command consumption
- Known limitation: real-GPU acceptance on kunshan-quant pending environment availability; mock-ssh coverage complete

## 0.11.0 (2026-08-14)

Phase 2 per plans/personal-harness-roadmap.md:

- Removed: agent-lifecycle, profile, renderer, core/config, tool-policy modules (dead code sweep)
- Permission: guard-layer — dropped `.kimi-code`/`KIMI_CODE_HOME` instruction hierarchy (AGENTS.md + `~/.agents` kept), removed `evaluateForSubagent` and `isActive` passthrough
- Renamed: all muselinn identifiers → lamboy (`PI_LAMBOY_*` env vars, `lamboy-tui.json`, `lamboy_*` entry types)
- Added: todo claim/release multi-session semantics (`done`/`drop` implicitly release the claim)
- Known limitation: todo markdown export/import does not round-trip claim state (same as `details`/`notes`)
- Upgraded: pi devDeps to 0.84.x

## 0.10.0 (2026-08-14)

Personal fork of pi-muselinn-harness 0.9.22. Breaking reduction per plans/personal-harness-roadmap.md:

- Removed: Swarm, Task/Cron, Webfetch, Skills scanner, Hooks engine, Plugin bundles, agent-file (superseded by pi-subagents / pi-web-access / pi native skills+packages)
- Removed: Kimi Code compat layer shipped with those modules
- Migrated: spinner primitives from core/swarm to core/tui
- Kept: Goal, Plan, Permission guards, Ask (foreground), Todo, Pause, TUI, Truncation
- Removed commands: `/swarm` `/tasks` `/cancel` `/resume` `/steer` `/plugins` `/swarm-status`; `ask_user_question` no longer accepts `background: true`
- Docs: README (en/zh-CN) pruned to post-reduction reality; Kimi references swept (phase-1 scope)

## 0.9.22

**Type-layer hardening — full-package `tsc` typecheck (first time):**

- Added `tsconfig.json` (es2024, bundler resolution, strict), `npm run typecheck`, and a typecheck step in CI. The runtime-JIT test strategy (node type stripping) erased all annotations, so type breakage was invisible to the suite — 158 strict errors cleared.
- Fixed broken type references: root `index.ts` referenced a non-existent `./types` module for `SubAgentTask`/`SwarmState` (4 sites) — now the real `packages/core/swarm/types` import; `permission/config.ts` was missing the `PermissionMode` import; `todo/index.ts` read a non-existent `SubAgentTask.description` (dead branch removed).
- `swarm/subagent.ts` `ResourceLoader` shim was missing `getSystemPromptSource`/`getAppendSystemPromptSources` (pi 0.83 requires them) — added.
- Removed dead `usage` fields from every `registerCommand` — pi 0.83 never reads `cmd.usage` (verified against dist runtime).
- Fixed silently-dead behavior: `resources_discover` skill injection called an unimported `listDiscoverableSkillFiles` (ReferenceError swallowed by `catch` — subagent skills silently missing); `session_end` does not exist in pi 0.83's event table (todo cleanup now bound to `session_shutdown`); single-agent `SubAgentTask` literals were missing required `toolCalls`/`estimatedTotalCalls`.
- Type-gap closures: `notify(..., "success")` is runtime-supported but absent from pi's type (module augmentation in `notify-augment.d.ts`); `AutocompleteItem` imported from `@earendil-works/pi-tui` (pi-coding-agent doesn't re-export it) with the required `label`; `Type.Optional(record, { description })` dropped its 2nd arg (description moved into `Type.Record` options); `createAgentSession` no longer passes the unsupported `modelRegistry` option; model reads now use pi's real `Model` type (vision detection via `model.input` type-safe); `TurnEndEvent` signal access guarded for multi-version compat.

## 0.9.21

**Window-aware tool-result spill (issue #2):**

- The 40k-char spill threshold was hardcoded and unaware of the model's
  context window — a 1M-context model was forced through the same disk
  spill + `read` round-trip as an 8k one. The threshold now scales with
  `ctx.model.contextWindow` (`max(40k, window × 4 chars/token)`, capped at
  800k chars ≈ 200k tokens so a single tool result can never balloon the
  context), and `PI_TRUNCATION_THRESHOLD` overrides it explicitly. Small
  windows keep the exact previous behavior.

**RPC approval dialog (issue #4) — no more silent denials in RPC hosts:**

- In pi RPC mode (obsidian-pi & other embedding clients) the approval dialog
  previously rendered through the TUI-only `ctx.ui.custom` path, which RPC
  hosts don't implement: every `ask` verdict in manual mode silently
  returned `User denied: <policy>` and the user never saw a prompt. The
  approval dialog now detects non-TUI hosts (`ctx.mode !== "tui"`) and
  falls back to the extension UI protocol that RPC hosts do implement —
  `select` (Allow once / Always allow / Deny / Deny with reason) with
  `input` for the deny reason and `confirm` as a last resort. Cancelling
  the reason input returns to the options (TUI parity); any host-side UI
  failure degrades to a fail-safe deny.

## 0.9.20

**Hotfix — npm package was missing the `pause/` adapter directory (issue #3):**

- The `files` whitelist in package.json did not include `pause/`, so the
  0.9.19 tarball shipped without `pause/commands.ts` and the extension
  failed to load (`Cannot find module './pause/commands'`). The directory
  is now part of the published package.

## 0.9.19

**Freeze & steer — `/pause` · transcript · `/steer`:**

- **`/pause` full-screen freeze** — the main agent and every swarm subagent
  park at their next safe boundary (tool-call gate): in-flight calls run to
  completion, nothing is aborted, and a later release continues exactly where
  each loop parked. A full-screen overlay (theme-colored pause glyph + live
  hold timer, terminal background as the backdrop) covers the terminal;
  esc/enter/space/ctrl+c releases. Releasing leaves a status line in the
  session transcript (`已恢复（暂停 13s）— 代理继续运行`), omp-style.
- **Transcript recording** — every subagent's conversation is written to
  `<sessionDir>/agents/<taskId>/wire.jsonl` (user / assistant → tool-call
  lines with timestamps, stop reasons and usage; tool arguments deliberately
  omitted). The task browser (`/tasks`, `ctrl+shift+t`) gains a conversation
  view (`c` key) showing formatted transcript lines.
- **`/steer <taskId> <message>`** — injects a message into a running subagent
  (swarm session or background task; Tab-completed task ids); the agent loop
  delivers it once the current tool call completes.
- **Pause overlay rendering fixes** — colors come from the active theme
  (`accent`/`text`/`muted`/`dim`), and block glyphs (█ / ⏸) are measured
  single-width so the pause symbol centers exactly with the text below.

## 0.9.18

**Persistent startup permission mode:**
- `"defaultMode": "auto" | "yolo" | "manual"` in `~/.pi/agent/permissions.json`
  (global) or `.pi/permissions.json` (project; global wins on conflict)
  replaces the hardcoded `manual` startup mode — new sessions start in your
  preferred mode without an interactive `/mode` call. Sessions with a
  recorded `/mode` history still restore the last used mode; `defaultMode`
  is the starting point for fresh sessions. Thanks @jason-in-hub for the
  contribution (PR #1)!

## 0.9.17

**Miscellaneous:**
- README (EN/中): releasing instructions moved from the user-facing README
  to the bottom of `CHANGELOG.md` (maintainer-only workflow); the release
  tag command now derives the version dynamically instead of a stale
  hardcoded `v0.9.1`.

## 0.9.16

**todo_list tool prompts de-ambiguated:**
- `op=init` now unambiguously requires `list=[{phase, items}]`; the top-level
  `items` field is documented as plain strings only (append), removing the
  "flat init fallback" phrasing that led models to pass object arrays and get
  schema validation errors (`items.0: must be string`).

## 0.9.15

**Todo widget auto-clear (OMP parity):**
- Closed (completed/abandoned) tasks are now removed from the plan after
  `PI_MUSELINN_TODO_CLEAR_DELAY` seconds (default 60, `0` = instant,
  `-1` = manual `/todo rm`) — finished plans fade out of the above-editor
  panel instead of lingering. The completion state shows briefly with a
  live countdown hint. New pure helper `removeClosedTasks()`; the timer is
  re-armed on every todo mutation and session restore, cancelled on session
  end.

## 0.9.14

**Startup fix:**
- `session_start` model catalog refresh is now fire-and-forget instead of
  awaited — a stalled catalog fetch (no signal/timeout) previously blocked the
  TUI input loop right after the interface rendered. Matches pi core's own
  background refresh behavior in `main.ts`.

**TUI polish:**
- **Shimmer working message (OMP-style)** — the editor border's working label
  gets a wall-clock driven light-band sweep (`classic` cosine band or `kitt`
  K.I.T.T. scanner, default classic); the crest paints accent+bold so dim text
  stays legible mid-animation. New `packages/core/tui/shimmer.ts` (pure, zero
  pi imports; ported from oh-my-pi, MIT) with three-tier palettes, ANSI run
  coalescing and a compiled-palette cache. `/tui shimmer <classic|kitt|disabled>`
  switches live, persisted to `muselinn-tui.json`.
- **Boxed editor spacing** — padding minimum 2 so the `│` bars never touch the
  text/cursor, and a `❯` prompt chevron on the first content line.
- **Stable animation frame-rate** — keep-alive timer uses a fixed 200ms quiet
  gate (~10fps ceiling), so a stalled
  agent loop costs at most ~10 full-tree renders per second even on very large
  sessions, and the cadence never changes (adaptive thresholds were tried and
  rejected — latency noise made the frame rate stutter).

**Docs & site:**
- README restructured for new users (what-is-this table, quick start) and the
  11 versions of release notes moved to a dedicated `CHANGELOG.md`; Pages
  home reworked with a quick-start section and a changelog page.
- Pages demo terminal now simulates the actual Pi + harness TUI: quiet-startup
  header, loaded-resources block, braille swarm grid widget, `╭╮│╰╯` boxed
  editor with spinner + model in the border, and the status-bar badges
  (permission mode / swarm / goal / agent count).

## 0.9.13

**Plan mode Kimi Code full alignment:**
- Plan injection rewritten to match Kimi Code's `plan-mode.ts` wording (full + sparse variants).
- `enter_plan_mode`, `exit_plan_mode`, and plan-file writes auto-approved (skip permission chain).
- Per-tool deny messages: TaskStop, CronCreate, CronDelete get specific reasons in plan mode.
- `isPlanFilePath()` shared helper for consistent plan-file path matching.
- Plan approval panel shows full file content (removed 500-char truncation).

**Permission dialog UX:**
- "Deny with reason" input: Esc now returns to the 4 options instead of ending the flow.
- Looped dialog matches the plan approval panel's Revise pattern.

**Subagent profile system:**
- New `packages/core/profile/` with CODER / EXPLORE / PLAN profiles.
- Tool permissions aligned with Kimi Code YAML definitions (bash in explore, no write in plan).
- Profiles injected via `buildProfileTools()` + `createSubagentResourceLoader()`.

**Preview box fix:**
- Trimmed Markdown trailing whitespace so box borders don't exceed terminal width.
- Accounted for pi-tui `Text` component's `paddingX=1` in stacked layout.

**Misc:**
- Replaced `theme.fg("info", ...)` with `theme.fg("accent", ...)` ("info" color didn't exist).
- `hasAnyPreviewOption()`: "n note" hint only shows when an option has a preview.
- Questionnaire arrow-key tab switching uses `matchesKey()` (Kitty protocol compatible).
- All 19 test suites green.

## 0.9.12

- Made `resources_discover` handler async and added timing.
- Wrapped `restoreTodos`, `bindTodoSession`, `refreshWidget`, and `loadPlugins` in try/catch.
- Removed unused `VisibleTodos` / `selectVisibleTodos` dead code (78 lines).
- Cleaned up MusePi fork references from README and docs.

## 0.9.11

- **Swarm report includes subagent output** — model sees what each subagent
  produced (Kimi Code parity).
- **Tool policy gate** — disabled tools blocked before permission chain.
- **Plan mode Kimi Code alignment** — bash no longer blocked in plan mode;
  only Write/Edit (outside plan file), TaskStop, Cron mutations blocked.
- All 12 test suites green

## 0.9.10

- **Ask dialog `n` note always visible** — Footer shows `· n note` unconditionally; any option can carry a note (OMP parity).
- All 12 test suites green

## 0.9.3–0.9.8

**Integration & consistency fixes:**
- Widget API fixed: `ctx.widget()` → `ctx.ui.setWidget("todo", content)`, empty list clears widget instead of showing "(empty)" clutter
- `/todo` subcommands aligned with oh-my-pi: `view` → `export`, added `copy`, `edit`, bare `/todo` prints Markdown
- Every `/todo` subcommand produces status feedback via `ctx.showStatus`
- Removed redundant `/todo help` / `?` (command registry provides discoverability)
- `clearTodoSession` now wired to `session_end` event (was imported but never called)
- `require()` → ES `import` for `swarmState` (require silently failed in bundled ESM runtime — subagent matching finally works)
- All 12 test suites green at every commit

## 0.9.1

**Bug fixes:**
- Fixed `add_notes` case in `applyEntry` — no longer falls through into `update_details` (all add_notes calls rejected with "Missing details value")
- Fixed stray `completed: number` in function body that blocked module parsing
- `todoMatchesAnyDescription` now correctly checks shorter string against longer one for substring matching
- All 94 TODO tests green, full suite 12/12

## 0.9.0

**TODO Phase Model — phased task planning with reminders built in.**

The todo system is rewritten with an oh-my-pi-style phase model (`TodoPhase`):
per-task status (`pending`/`in_progress`/`completed`/`abandoned`), 7 ops
(`init`/`start`/`done`/`drop`/`rm`/`append`/`view`), and auto-promote of the
first task on phase init. The widget renders a roman-numeral phase tree
(`Ⅰ. Scanner · 2/4`) with collapse/expand.

**Reminder system:** When the agent stops with incomplete todos, a
`<system-reminder>` injects the task list into the next turn (max 3
reminders, debounced).

**Markdown round-trip:** `/todo export/import` serializes and restores phases
as Markdown for sharing and persistence between sessions.

**Plan Mode — Kimi Code permission model alignment.**

Plan mode no longer maintains its own bash command whitelist. Instead, bash
follows the normal permission mode (auto/yolo/manual) — the same design as
Kimi Code. Only the following are blocked during planning:
- **Write/Edit** to files outside the active plan file
- **TaskStop** (would abort background work during planning)
- **CronCreate / CronDelete** (would mutate scheduled work)

The plan file path is matched by exact path, `local://` scheme basename, and
resolved absolute path under the session's `plans/` directory — all three paths
accepted.

This eliminates the root cause of "stuck in plan mode" where common commands
like `cd` were blocked by the bash whitelist, and plan file writes using the
`local://` scheme were rejected.

**Plan mode bash permission model:**

| Before (0.8.2) | After (0.9.0) |
|---|---|
| Static regex whitelist (~35 commands) | No bash restriction — follows permission mode |
| `cd` not in whitelist → blocked | `cd`, `git push`, `npm install` all allowed (permission mode decides) |
| `local://` plan writes rejected (path mismatch) | `local://` basename matched against active plan file |
| Deny-by-default for unmatched commands | Allow-by-default, permission chain controls |

## 0.8.2

**Custom Agent Files** — Define agent profiles as Markdown files with YAML frontmatter:
```markdown
---
name: my-coder
description: Custom coding agent with restricted tools
tools:
  - Read
  - Grep
  - Edit
  - Bash
disallowedTools:
  - Bash
---
You are a specialized coding agent.
${base_prompt}
```
Place them in `.pi/agents/`, `.kimi-code/agents/`, or `.agents/agents/` (project or user scope).
Use `agent_file_list` to browse, and pass `agent_file="my-coder"` to `agent` or `agent_swarm`.

**Tool Gating** — Three-layer tool policy integrated into the permission chain.
Agent profiles can restrict which tools a subagent may use; the policy is enforced
at the `tool_call` event level, before the 18-level permission chain.

**Agent Lifecycle Events** — `agent.created` / `agent.disposed` events tracked
per subagent. Active agent count shown in the status bar (`[3 agents running]`).

**Permission Mode Rework (kimi-code aligned):**
- **Auto** — truly automatic: no dialogs for any tool (including destructive/sensitive).
  `AskUserQuestion` is disabled. `ExitPlanMode` auto-approves with a warning.
- **YOLO** — fast but still safe: destructive commands, `.env` access, `.git` paths
  still require approval. `AskUserQuestion` is allowed. `ExitPlanMode` shows review.
- **Manual** — full 18-level policy chain with fallback-ask.

**Plan Mode improvements:**
- `task_stop` / `cron_create` / `cron_delete` blocked during planning
- Sparse/full injection reminders (less prompt bloat on long planning sessions)
- Auto-mode ExitPlanMode warns "user has NOT explicitly approved"

## 0.7.8

- **Task module reliability fixes** — the two root causes behind broken background tasks on pi ≥ 0.81:
  - `run_background` died at spawn (`task_output` empty, `block:true` returned instantly): the subagent resource loader omitted `LoadExtensionsResult.runtime`, which pi 0.81's `ExtensionRunner.bindCore` requires — `createAgentSession` threw and every background task failed immediately. The loader now includes the runtime when the SDK provides it (still 0.80-compatible)
  - `task_list` crashed with no arguments while `active_only:true` worked: restored persisted entries carry the task text as `description` (or not at all), and the list formatter called `prompt.slice()` on `undefined`. Restore now maps `description` → `prompt` and defaults missing prompts; `task_output` also surfaces `[task failed: <error>]` for tasks that died before producing output
- **Plan persistence dedup** — `PlanManager.persist()` skips appends identical to the last persisted state (observed: 5 identical `muselinn_plan` entries within 25 s), and restore seeds the dedup baseline so a no-change persist doesn't re-append
- **Tests** — new `task.test.mjs` suite (16 checks) + plan dedup regression cases; 19 suites / 580 assertions, all green

## 0.7.7

- **Plan mode fixes** — the bash read-only gate now understands `rtk`-wrapped commands (pi-rtk-optimizer rewrites commands in place) and Windows `dir`; **Revise** keeps the same plan object instead of trapping you or losing work; review timeout raised 60 s → 600 s; a stale persisted plan with no file on disk deactivates cleanly instead of trapping the session; the `plan` badge now also follows tool-driven plan mode
- **Goal fixes** — footer badge counters (`turns` / tokens / wall-clock) restore monotonically, so they never flicker backwards; completed goals leave a tombstone entry and can't be resurrected with stale counters; `update_goal` docs now state the `verified=true` rule explicitly (required to complete a goal with a declared criterion)
- **Ask dialog robustness** — scrolling window for long option lists, answer deduplication, and background-question support, on top of the tabbed multi-question dialog (multi-select + free-text Other)
- **CI/CD** — GitHub Actions test matrix (ubuntu + windows × node 22/24) on every push/PR

## 0.7.4

- **`ask_user_question` tool** — native interactive question dialog with numbered options, shared with the approval flow
- **`todo_list` tool + inline panel** — session-shared todo with collapse policy (replaces external rpiv-todo)
- **Approval panel** — per-tool titles, number-key selection, reject-with-reason (manual permission tier)
- **Swarm permission gating** — shared permission manager; `/mode` broadcasts to all subagents
- **Editor anchoring** — input anchored after slash-menu closes (render-edge detection)
- **`toolResultTruncation`** — oversized tool results persisted to disk with preview + `output_path`
- **Subagent resume guard** — ownership/idle validation before resuming
- **`fetch_url` tool** — no-auth URL fetching (replaces external dependency)
- **Plugin manifest** — six-piece package metadata set


![Closed-box editor with streaming state in the top border](https://muselinn.github.io/pi-muselinn-harness/assets/img/pi-boxed-editor.png)


---

## Releasing (maintainers)

Changelog entries describe **user-visible changes only** — CI/tooling/docs
housekeeping stays in git history, not release notes (the release body is
generated from CHANGELOG.md, so it inherits this rule).

Tag to mark the release (CI publish removed — publish locally with OTP):

```bash
npm run version-patch                              # bumps package.json + lock (e.g. 0.9.16 → 0.9.17)
git tag v$(node -p "require('./package.json').version")
git push origin main --tags                        # tag push runs CI + auto-creates the GitHub Release
npm publish                                        # manual publish with OTP
```
