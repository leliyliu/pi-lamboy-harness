# pi-lamboy-harness

**个人专属 Pi 编排底座** — Goal（目标生命周期/预算/队列）· Plan（计划门控）· Permission（危险操作守卫）· Ask（结构化提问）· Todo（阶段任务）· Pause（冻结检查）· TUI · Truncation（大输出溢出）。

Fork 自 [MuseLinn/pi-muselinn-harness](https://github.com/MuseLinn/pi-muselinn-harness) 0.9.22（感谢原作者）。
个人改造路线：`plans/personal-harness-roadmap.md`。
子代理/定时任务/搜索/MCP 由白名单第三方包提供（pi-subagents、pi-web-access、pi-mcp-adapter 等），本包只维护差异化核心。

## Quick start

```bash
pi install git:github.com/leliyliu/pi-lamboy-harness   # personal fork; or: pi install /path/to/pi-lamboy-harness
pi                                                      # restart, then:
```

Try it out:

```
/goal Refactor the auth module           # set a goal with budget tracking
/todo init "Phase 1: scanner"            # start a phased task plan
/plan                                    # enter plan mode (read-only exploration)
/pause                                   # freeze; esc/enter/space/ctrl+c resumes
/tui style plain|boxed|compact           # switch editor chrome anytime
```

All tools are model-callable, all commands are slash commands with Tab completion.

## Features

### Pause (freeze, inspect)

- **`/pause` full-screen freeze** — the agent parks at the next safe boundary
  (tool-call gate): in-flight calls run to completion, nothing is aborted, and
  a later release continues exactly where the loop parked. A full-screen
  overlay — theme-colored pause glyph, live hold timer — covers the terminal;
  esc/enter/space/ctrl+c releases, leaving a status line in the session
  transcript (`已恢复（暂停 13s）— 代理继续运行`). When the pause lands
  mid-tool, the overlay tags it `<tool_call>`.
- **Safe boundaries** — cancelling a parked run (AbortSignal) unwinds only
  that wait, never the gate.
- **Theme-colored overlay** — icon/headline/body/hints render with the active
  theme's `accent`/`text`/`muted`/`dim`; the terminal background is the
  backdrop. Block glyphs (█ / ⏸) are measured single-width, so the pause
  symbol centers exactly with the text below.

### Goal
- **Lifecycle** — active / paused / blocked / complete / usage_limited / budget_limited
- **Active Guard** — `create_goal` refuses to silently overwrite an active goal (`replace=true` or `/goal replace`)
- **Blocked 3-turn threshold** — three consecutive blocks for the same reason before really blocking
- **Completion-criterion gate** — a declared criterion must be verified before completing (`verified=true` in the same `update_goal` call; documented in the tool description)
- **Triple budget checks** — tokenBudget + turnBudget + wallClockBudgetMs (`turns/tokens/ms/s/minutes/hours`)
- **Goal Queue** — FIFO + high/normal priority + auto-switch + prioritize/drop/skip
- **Persistence** — appendEntry + session_start restore; counters merge **monotonically** (max per goalId), so a stale entry can never pull turns/tokens backwards; `clear()` writes a tombstone entry so completed goals stay completed
- **Context injection** — `<untrusted_objective>` tag into the system prompt
- **Recovery** — compaction preservation + context-overflow detection + 429 detection

### Plan
- **Plan mode** — the LLM explores, writes a plan, and only executes after approval
- **Permission model** — bash is NOT blocked in plan mode; it follows the normal permission mode (auto/yolo/manual). Only Write/Edit (outside the plan file) are blocked
- **Plan file path matching** — exact path, `local://` scheme basename, and resolved absolute path under `sessionDir/plans/` — all three accepted
- **ExitPlanMode reads the plan file** — presentation matches what was actually written to disk
- **Revise keeps your plan** — a revised or cancelled review re-enters plan mode with the same plan object (id/path/content), never a trap, never lost work; review timeout 600 s
- **Restore validation** — a stale persisted active-plan entry with no content and no file on disk deactivates plan mode instead of trapping the session
- **Context injection** — the plan is injected into the system prompt

### Permission
- **Policy chain** — `auto` / `yolo` / `manual`; safety policies (destructive, sensitive files) short-circuit before modes
- **Destructive detection** — `rm -rf` / `git push --force` / `drop table` / `git reset --hard` regex recognition, always asks, never short-circuited by session approvals
- **Sensitive-file guard** — `.env` / `id_rsa` / `*.key` read/write interception, even in auto mode
- **Session approval fingerprints** — approvals remembered per sessionId + input fingerprint, never degrading into "permanent allow"
- **Approval panel** — numbered dialog with per-tool action titles ("Run this command?" / "Apply these edits?"), digit-key direct select, four outcomes: Allow once / Always allow (session) / Deny / Deny with reason (reason relayed to the model). In RPC hosts (obsidian-pi etc.) the same choices render over the extension UI protocol (`select` / `input` / `confirm`) instead of the TUI dialog — no more silent denials
- **AGENTS.md hierarchy** — project (nearest `AGENTS.md` or `.kimi-code/AGENTS.md`) → global `$KIMI_CODE_HOME/AGENTS.md` → cross-tool `~/.agents/AGENTS.md`, aggregated; `destructive-ask-always` can upgrade ask to deny
- **Config cache** — permission config cached by file mtime, edits take effect immediately
- **Persistent startup mode** — optional `"defaultMode": "auto" | "yolo" | "manual"` in `~/.pi/agent/permissions.json` (global) or `.pi/permissions.json` (project; global wins on conflict) replaces the hardcoded `manual` startup mode, so new sessions start in your preferred mode without an interactive `/mode` call. A session with a recorded `/mode` history still restores the last used mode; `defaultMode` is the starting point for fresh sessions.

### TUI
- **Closed-box editor** — Kimi Code's `wrapWithSideBorders` ported: pi-tui's horizontal-only borders post-processed into a `╭╮│╰╯` closed box; spinner + working state (Thinking/Streaming/Running tools) embedded in the top border; three styles `plain | boxed | compact` (pi-spark-style info border = compact), default boxed; model name opt-in via `"modelInBorder": true`

  The first content line carries a prompt chevron (`│❯ text │`), padding is
  clamped to ≥2 so the bars never touch the text or cursor.
- **`/tui` command** — hot-switch styles without restarting (pi preserves text/focus/keybindings when swapping editors); `/tui timing` shows render timing; config persisted to `~/.pi/agent/muselinn-tui.json` (project `.pi/` override)
- **Plan badge** — `plan` text badge on the top border while plan mode is active (no border recoloring — zero conflict with pi's thinking-level colors)
- **Timing probe** — `PI_MUSELINN_HARNESS_TUI_TIMING=1` records editor `render()` P50/P99; spinner only ticks at 250 ms while the agent works
- **Shimmer working message (OMP-style)** — the working label in the editor border gets a wall-clock driven light-band sweep (`classic` cosine band or `kitt` K.I.T.T. scanner); the crest paints accent+bold so dim text stays legible mid-animation. `low: dim / mid: muted / high: accent` by default; `/tui shimmer <classic|kitt|disabled>` switches live, config persisted
- **Stable animation frame-rate** — the keep-alive timer uses a fixed 200ms quiet gate (≈10fps ceiling) so the animation cadence never changes; natural streaming renders ride pi's own frames at zero extra cost, and a stalled agent loop costs at most ~10 full-tree renders per second even on very large sessions. (Adaptive thresholds based on measured render latency were tried and rejected: latency noise made the frame rate stutter.)

### Ask (interactive questions)
- **`ask_user_question` tool** — the agent asks 1-4 structured questions in one tabbed dialog: per-question header tabs (`1/3 · header`, ←/→/Tab to switch), numbered options with description sub-lines, `multi_select` checkboxes (Space toggles, Enter confirms), and an automatic free-text **Other** option on every question; digit keys 1-9 jump straight to an option, arrows/jk navigate, Esc cancels
- **Robust by default** — long option lists scroll inside a bounded window, and duplicate answers are deduplicated
- **Previews, notes, chat row** — options can carry Markdown **previews** (side-by-side pane on wide terminals, stacked below on narrow ones); attach a per-option **note** with `n`; a **Chat about this** row ends the dialog with a `chat` result so the user can discuss the question instead of answering it
- **Shared dialog component** — the same component backs permission approval (single-select, no Other); in print mode the tool returns the questions as text instead of blocking, and in RPC mode permission approvals fall back to `select`/`confirm`/`input`
- **Answer reporting** — per-question answers (multi-select as an array); skipped questions and Esc-cancelled dialogs are reported distinctly
- **Auto-mode safe** — auto mode denies `ask_user_question` by policy (no unattended hangs)

### Todo
- **Inline panel** — above-editor widget with roman-numeral phase tree (`Ⅰ. Scanner · 2/4`), `/todo toggle` expand/collapse; finished tasks auto-clear after `PI_MUSELINN_TODO_CLEAR_DELAY` seconds (default 60, `0` = instant, `-1` = manual) so completed plans fade out of the HUD instead of lingering
- **`/todo` command** — full oh-my-pi phase model: `init`, `start`, `done`, `drop`, `rm`, `append`, `export`, `import`, `copy`, `edit`, `add_notes`, `update_details`, bare `/todo` prints Markdown
- **`todo_list` tool** — model-driven task management with same ops
- **Reminder system** — incomplete todos injected as `<system-reminder>` when agent stops (max 3 reminders, debounced)
- **Markdown round-trip** — `/todo export/import` for persistence and sharing between sessions
- **Notes** — per-task notes via `add_notes` / `update_details`
- **Phase counts** — widget header shows `N active · M pending · K done`
- **Session persistence** — survives hot-reload and session restart

### Output truncation
- **Oversized tool results spill to disk** — results over the spill threshold are written to `<sessionDir>/tool-results/` and replaced in context with a sanitized head+tail preview carrying the `output_path` and read-paging instructions (`toolResultTruncation` pattern)
- **Window-aware threshold** — the threshold scales with the active model's context window (`max(40k, window × 4 chars/token)`, capped at 800k chars ≈ 200k tokens), so 1M-context models keep far more output in-context; `PI_TRUNCATION_THRESHOLD` overrides it explicitly

## Commands

| Command | Description |
|---------|-------------|
| `/pause` | Freeze the agent at the next safe boundary (esc/enter/space/ctrl+c resumes) |
| `/goal <objective>` | Set a goal |
| `/todo` | Task plan with phase model; shortcuts: `start` `done` `drop` `export` `import` `copy` `edit` `toggle` |
| `/todo toggle` | Expand/collapse the todo panel (replaces former `alt+t`) |

> `/goal` `/plan` `/mode` `/tui` all support Tab completion.

## Tools

| Tool | Description |
|------|-------------|
| `create_goal` / `get_goal` / `update_goal` / `set_goal_budget` | Goal management |
| `enter_plan_mode` / `exit_plan_mode` | Plan mode |
| `ask_user_question` | Tabbed structured questions (multi-select, Other free text) |
| `todo_list` | Model-driven task plan with inline panel |

## Architecture

Core/adapter split: `packages/core/` is pure logic with **zero pi imports**;
the repo root holds the pi adapter (entry, pi-tui components, tool registration).

```
pi-lamboy-harness/
├── index.ts               entry (permission/plan wiring, truncation, module registration)
├── packages/core/         @muselinn/core — pure logic, no host imports
│   ├── ports.ts           host contracts (PersistencePort, ScopeDirs)
│   ├── text-utils.ts      visibleWidth & friends
│   ├── shell-output.ts    control-sequence sanitizer
│   ├── truncation/        oversized tool-result spill (pure)
│   ├── completions.ts     slash-command argument completions
│   ├── ask/               question spec + formatting (pure)
│   ├── todo/              todo model + folding strategy (pure)
│   ├── goal/              Goal module (state machine, budgets, queue, persistence)
│   ├── plan/              Plan module (tool whitelist, path guard, injection)
│   ├── permission/        Permission module (policy chain, approval contract)
│   ├── pause/             pause gate + full-screen overlay layout (pure, theme-injectable)
│   ├── profile/           sub-agent profile definitions (unused — Phase 2 cleanup)
│   └── tui/               box/config/parse/switch/timing/spinner (pure chrome parts)
├── pause/                 adapter: /pause overlay component
├── tui/                   adapter: MuselinnEditor + event wiring
├── ask/                   adapter: question dialog + ask_user_question tool
├── todo/                  adapter: todo_list tool + inline panel widget
└── tests/                 node-level unit tests (below)
```

## Tests

Pure node-level unit tests, no model quota needed (18 suites, 600 assertions):

```bash
npm test                                        # all suites (node tests/run-all.mjs)
npm run typecheck                               # full-package tsc (strict, es2024)
```

or individually:

```bash
node tests/musepi-config.test.mjs                 # MusePi config compat — 9
node tests/permission.test.mjs                    # Permission policy chain — 26
node tests/goal.test.mjs                          # Goal state machine + monotonic restore — 32
node tests/plan.test.mjs                          # Plan mode round-trip + restore validation — 37
node tests/tui.test.mjs                           # TUI collapse/keys/completions/spinner — 36
node tests/tui-box.test.mjs                       # TUI box/config/probe/switch — 63
node tests/tui-adapter.test.mjs                   # TUI adapter working-state render path — 4
node tests/agent-lifecycle.test.mjs               # agent lifecycle events — 6
node tests/ask.test.mjs                           # ask spec/dialog/answers/approval titles — 118
node tests/tool-policy.test.mjs                  # tool policy gate — 13
node tests/pause-gate.test.mjs                    # pause gate + full-screen render — 54
node tests/todo.test.mjs                          # todo model + folding strategy — 99
node tests/shell-output.test.mjs                  # output sanitizer — 21
node tests/shimmer.test.mjs                     # shimmer sweep engine — 10
node tests/truncation.test.mjs                    # tool-result spill + window-aware threshold — 21
node tests/approval-rpc.test.mjs                  # RPC approval fallback (select/confirm) — 21
node tests/renderer.test.mjs                      # incremental renderer buffer/tree — 16
node tests/stream-rules.test.mjs                  # stream entry rules — 14
```

The suites run on Node 22/24/26 (22.6–22.17 via
`--experimental-strip-types`, older legs via `tests/ts-esm-loader.mjs`; 22.18+
strips types natively).

## Roadmap

- **i18n** — bilingual harness UI text and notifications (docs are already split en/zh-CN)
- **Math renderer graduation** — merge `feature/math-renderer` once compaction-path context safety is confirmed
- **Clustered diff preview** — ±3-line clustered diffs in edit/write approval messages (deferred from the P1 batch)

## Dependencies

- Pi >= 0.80.0
- `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` (peers)
- `typebox`

## Experimental branches

- [`feature/math-renderer`](https://github.com/MuseLinn/pi-muselinn-harness/tree/feature/math-renderer) — renders `$$...$$` display math in assistant messages via [txm](https://github.com/thatmagicalcat/txm) (cell-based 2D typesetting, works in Windows Terminal; no image protocol). Context-safe: the original Markdown is restored before every LLM call. Enable with `/tui math on` after `cargo install txm`.

## Acknowledgments

Design and implementation inspired by these open-source projects:

### [Kimi Code](https://github.com/MoonshotAI/Kimi-code) (Moonshot AI)
- Agent Swarm concurrency architecture (max_concurrency worker pool, 30-min timeout, run_in_background)
- Goal system design (GoalActor tracking, Budget Report, blocked 3-turn threshold, context injection)
- Plan-mode lifecycle (enter/exit/approve/reject, ExitPlanMode disk read)
- Permission policy chain (auto/yolo/manual, destructive-always-ask, AGENTS.md priority)
- Cron scheduling (5-field + jitter + 7-day stale + 50 cap)
- TUI component design (braille progress bars, three-pane task browser, `wrapWithSideBorders` closed-box editor)
- Cancel/resume mechanism (AbortSignal chain, UserCancellationError)

### [pi-spark](https://github.com/zlliang/pi-spark) (zlliang)
- Editor top-border info slots (spinner + working state + model embedded in the border)
- Component-replacement TUI customization path (`setEditorComponent` / `setFooter` / `setWidget`)

### [@narumitw/pi-goal](https://www.npmjs.com/package/@narumitw/pi-goal) (narumitw)
- Goal Queue FIFO + auto-switch mechanism
- usage_limited / budget_limited state design
- Wrap-up instruction injection (post-budget behavior)
- Stale Tool Blocking design
- Compaction retention policy

### [pi-codex-goal](https://www.npmjs.com/package/pi-codex-goal) (fitchmultz)
- Goal persistence (appendEntry + session_start restore)
- Goal state transitions
- Budget checking
- Recovery Machine concept (simplified)

---

**Note**: this extension is mostly an independent implementation. Exception: `tui/box.ts`'s `wrapWithSideBorders` is ported from Kimi Code (MIT), with attribution kept in comments and used under the MIT license.


## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## License

[MIT](LICENSE)
