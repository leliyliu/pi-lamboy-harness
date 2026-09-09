# pi-lamboy-harness

**个人专属 Pi 编排底座** — Goal（目标生命周期/预算/队列）· Plan（计划门控）· Permission（危险操作守卫）· Ask（结构化提问）· Todo（阶段任务）· Pause（冻结检查）· TUI · Truncation（大输出溢出）· Perf（基准/剖析）· Latex（编译/引用）。

Fork 自 [MuseLinn/pi-muselinn-harness](https://github.com/MuseLinn/pi-muselinn-harness) 0.9.22（感谢原作者）。
个人改造路线：`plans/personal-harness-roadmap.md`；生态审计与最小集决策：`plans/2026-09-06-*.md`。
子代理/定时任务/搜索/MCP 由白名单第三方包提供（pi-subagents、pi-web-access、pi-mcp-adapter 等），本包只维护差异化核心。

**v0.14.0 起每个模块都是独立的扩展入口**（`extensions/10-pause.ts` … `95-latex.ts`）——可用 settings.json 的 object-form 过滤按需启用任意子集，与第三方包同一套官方拆分机制；`presets/` 目录把启用面版本化，支持最小集/全量一键切换。

## Quick start

```bash
# Full install (all 10 module entries load)
pi install git:github.com/leliyliu/pi-lamboy-harness   # or: pi install /path/to/pi-lamboy-harness

# Or minimal install (filtered to 8 entries; perf/latex off) —
# write the object-form entry in settings.json, or just use a preset (see Presets below)

# Personal extras (JD Cloud image generation + JoySpace import, optional)
pi install /path/to/pi-lamboy-harness/personal

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

> **Modular entries**: every module is an independent extension entry — trim to any subset via object-form filtering in settings.json, e.g. just the trio:
> ```json
> { "source": "/path/to/pi-lamboy-harness",
>   "extensions": ["extensions/10-pause.ts", "extensions/20-plan.ts", "extensions/80-truncation.ts"] }
> ```
> Entries load in lexical order; numeric prefixes pin the tool_call gate chain (pause → plan → permission). Filtered-out modules register no tools/commands/events — zero context cost. The entry for each feature is listed in the Commands/Tools tables below.

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
- **AGENTS.md hierarchy** — project (nearest `AGENTS.md`, walking up) → cross-tool `~/.agents/AGENTS.md`, aggregated; `destructive-ask-always` can upgrade ask to deny
- **Config cache** — permission config cached by file mtime, edits take effect immediately
- **Persistent startup mode** — optional `"defaultMode": "auto" | "yolo" | "manual"` in `~/.pi/agent/permissions.json` (global) or `.pi/permissions.json` (project; global wins on conflict) replaces the hardcoded `manual` startup mode, so new sessions start in your preferred mode without an interactive `/mode` call. A session with a recorded `/mode` history still restores the last used mode; `defaultMode` is the starting point for fresh sessions.

### TUI
- **Closed-box editor** — Kimi Code's `wrapWithSideBorders` ported: pi-tui's horizontal-only borders post-processed into a `╭╮│╰╯` closed box; spinner + working state (Thinking/Streaming/Running tools) embedded in the top border; three styles `plain | boxed | compact` (pi-spark-style info border = compact), default boxed; model name opt-in via `"modelInBorder": true`

  The first content line carries a prompt chevron (`│❯ text │`), padding is
  clamped to ≥2 so the bars never touch the text or cursor.
- **`/tui` command** — hot-switch styles without restarting (pi preserves text/focus/keybindings when swapping editors); `/tui timing` shows render timing; config persisted to `~/.pi/agent/lamboy-tui.json` (project `.pi/` override)
- **Plan badge** — `plan` text badge on the top border while plan mode is active (no border recoloring — zero conflict with pi's thinking-level colors)
- **Timing probe** — `PI_LAMBOY_TUI_TIMING=1` records editor `render()` P50/P99; spinner only ticks at 250 ms while the agent works
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
- **Inline panel** — above-editor widget with roman-numeral phase tree (`Ⅰ. Scanner · 2/4`), `/todo toggle` expand/collapse; finished tasks auto-clear after `PI_LAMBOY_TODO_CLEAR_DELAY` seconds (default 60, `0` = instant, `-1` = manual) so completed plans fade out of the HUD instead of lingering
- **`/todo` command** — full oh-my-pi phase model: `init`, `start`, `done`, `drop`, `rm`, `append`, `export`, `import`, `copy`, `edit`, `add_notes`, `update_details`, bare `/todo` prints Markdown
- **`todo_list` tool** — model-driven task management with same ops
- **Claim/release** — multi-session collaboration: a task claimed by another session cannot be re-claimed; `done`/`drop` implicitly release the claim
- **Reminder system** — incomplete todos injected as `<system-reminder>` when agent stops (max 3 reminders, debounced)
- **Markdown round-trip** — `/todo export/import` for persistence and sharing between sessions
- **Notes** — per-task notes via `add_notes` / `update_details`
- **Phase counts** — widget header shows `N active · M pending · K done`
- **Session persistence** — survives hot-reload and session restart

### Output truncation
- **Oversized tool results spill to disk** — results over the spill threshold are written to `<sessionDir>/tool-results/` and replaced in context with a sanitized head+tail preview carrying the `output_path` and read-paging instructions (`toolResultTruncation` pattern)
- **Window-aware threshold** — the threshold scales with the active model's context window (`max(40k, window × 4 chars/token)`, capped at 800k chars ≈ 200k tokens), so 1M-context models keep far more output in-context; `PI_TRUNCATION_THRESHOLD` overrides it explicitly

### Perf lab
- **Measurement layer** — remote GPU benchmarks via ssh, PyTorch profiler analysis, and A/B significance testing, decoupled from pi-multiloop (which consumes `.perf/<run-id>.json` via verify commands)
- **`bench_run`** — N-run benchmark with MAD outlier rejection and P50/P95 (not the mean — GPU timing is noisy), plus an env snapshot (nvidia-smi model/driver/clocks) so cross-day comparisons catch environment drift
- **`profile_parse`** — torch profiler trace → hotspot table (op/kernel, self-time %, calls, shapes) the model can reason over directly
- **`metric_compare`** — Mann-Whitney significance verdict (improve/regress/noise); when noise dominates it advises more runs instead of a false call

### Latex toolchain
- **Compile & diagnose** — `latex_compile` runs tectonic locally and turns raw engine output into structured `file:line` errors with fix hints (undefined ref → rerun/check key, missing `$` → check math delimiters), so the model can repair a paper instead of reading log soup
- **Citation consistency** — `bibtex_check` cross-checks `.tex` citations against `.bib` for undefined-citation / unused-entry / duplicate-key issues (metadata validation is left to pi-bib)
- **`/compile [file]`** — slash-command shortcut; no argument scans the directory for the single main `.tex`
- **Prerequisite** — requires `tectonic` (`brew install tectonic`); graceful "tectonic not found" error otherwise

## Commands

| Command | Description | Entry |
|---------|-------------|-------|
| `/pause` | Freeze the agent at the next safe boundary (esc/enter/space/ctrl+c resumes) | `10-pause.ts` |
| `/goal <objective>` | Set a goal | `40-goal.ts` |
| `/plan` | Enter/manage plan mode | `20-plan.ts` |
| `/mode` | Permission mode (auto/yolo/manual) | `30-permission.ts` |
| `/todo` | Task plan with phase model; shortcuts: `start` `done` `drop` `export` `import` `copy` `edit` `toggle` | `60-todo.ts` |
| `/todo toggle` | Expand/collapse the todo panel (replaces former `alt+t`) | `60-todo.ts` |
| `/tui` | Hot-switch editor style/shimmer/timing | `70-tui.ts` |
| `/compile [file]` | LaTeX compile shortcut (auto-detects the single main `.tex`) | `95-latex.ts` |

> `/goal` `/plan` `/mode` `/tui` all support Tab completion.

## Tools

| Tool | Description | Entry |
|------|-------------|-------|
| `create_goal` / `get_goal` / `update_goal` / `set_goal_budget` | Goal management | `40-goal.ts` |
| `enter_plan_mode` / `exit_plan_mode` | Plan mode | `20-plan.ts` |
| `ask_user_question` | Tabbed structured questions (multi-select, Other free text) | `50-ask.ts` |
| `todo_list` | Model-driven task plan with inline panel | `60-todo.ts` |
| `bench_run` | Remote GPU benchmark (ssh to host, N-run P50/P95/MAD stats, env snapshot); results persist to `.perf/<run-id>.json` for pi-multiloop verify-command consumption | `90-perf.ts` |
| `profile_parse` | Parse a PyTorch profiler trace into a hotspot table (op/kernel, self-time %, calls, shapes) | `90-perf.ts` |
| `metric_compare` | Mann-Whitney significance test between two `.perf/` results → improve/regress/noise verdict | `90-perf.ts` |
| `latex_compile` | Compile a `.tex` via tectonic → structured `file:line` errors with fix hints + PDF path (requires `brew install tectonic`) | `95-latex.ts` |
| `bibtex_check` | Cross-check `.tex` citations against `.bib` → undefined-citation / unused-entry / duplicate-key report | `95-latex.ts` |

## Architecture

Core/adapter split: `packages/core/` is pure logic with **zero pi imports**;
the repo root holds the pi adapter (entry, pi-tui components, tool registration).

```
pi-lamboy-harness/
├── extensions/            per-module extension entries (load in lexical order;
│   │                      numeric prefixes pin the tool_call gate order:
│   │                      pause → plan → permission; filter any subset via
│   │                      object-form `extensions` in settings.json)
│   ├── 10-pause.ts        /pause + pause gate wiring
│   ├── 20-plan.ts         Plan Mode tools/commands/persistence/gate
│   ├── 30-permission.ts   /mode + policy chain + approval dialog
│   ├── 40-goal.ts         goal tools/commands/persistence/budget/badges
│   ├── 50-ask.ts          ask_user_question tool
│   ├── 60-todo.ts         todo_list + /todo + inline panel
│   ├── 70-tui.ts          /tui + editor chrome + plan badge
│   ├── 80-truncation.ts   tool-result spill (window-aware)
│   ├── 90-perf.ts         bench_run / profile_parse / metric_compare
│   └── 95-latex.ts        latex_compile / bibtex_check + /compile
├── personal/              optional personal pi package (image2 + joyspace) — install separately
├── presets/               versioned package-set presets + switch.mjs (minimal/full)
├── packages/core/         @lamboy/core — pure logic, no host imports
│   ├── ports.ts           host contracts (PersistencePort, ScopeDirs)
│   ├── text-utils.ts      visibleWidth & friends
│   ├── shell-output.ts    control-sequence sanitizer
│   ├── stream-rules/      stream entry rule engine (pure)
│   ├── truncation/        oversized tool-result spill (pure)
│   ├── completions.ts     slash-command argument completions
│   ├── ask/               question spec + formatting (pure)
│   ├── todo/              todo model + folding strategy + claim/release (pure)
│   ├── goal/              Goal module (state machine, budgets, queue, persistence)
│   ├── plan/              Plan module (tool whitelist, path guard, injection)
│   ├── permission/        Permission module (policy chain, approval contract)
│   ├── pause/             pause gate + full-screen overlay layout (pure, theme-injectable)
│   ├── perf/              bench stats / torch-profile parse / ssh assembly (pure)
│   ├── latex/             tectonic log parse + bib consistency check (pure)
│   └── tui/               box/config/parse/switch/timing/spinner (pure chrome parts)
├── pause/                 adapter: /pause overlay component
├── tui/                   adapter: LamboyEditor + event wiring
├── ask/                   adapter: question dialog + ask_user_question tool
├── todo/                  adapter: todo_list tool + inline panel widget
├── perf/                  adapter: bench_run / profile_parse / metric_compare tools
├── latex/                 adapter: latex_compile / bibtex_check tools + /compile command
└── tests/                 node-level unit tests (below)
```

## Presets (active-surface versioning)

What's installed is decided solely by the `packages` array in `~/.pi/agent/settings.json`; `presets/` version-controls that config inside the repo. Physical installs are **never deleted** — switching only changes the active surface:

| File | Purpose |
|------|---------|
| `minimal.v0.1.json` | Minimal unit: harness 8/10 entries (perf/latex filtered out) + personal + 5 full packages (subagents/web-access/research/mcp-adapter/focus-bell) + pie filtered to loop/files/powerline-footer + grill-with-docs skill |
| `full.snapshot.2026-09-06.json` | Full baseline: the original 13 packages + personal + grill |
| `switch.mjs` | Switch script: timestamped backup → atomic packages-array replace → sideline loose copies into `disabled/` → before/after diff |
| `catalog.md` | Add-back menu + conflict rules |

```bash
node presets/switch.mjs list                  # show presets + current state
node presets/switch.mjs diff minimal.v0.1     # preview changes (no writes)
node presets/switch.mjs minimal.v0.1          # switch to the minimal set
node presets/switch.mjs full                  # restore the full set
```

**Known hard rules** (see `presets/catalog.md`):

1. **Tool-name conflicts are fatal load errors** (not graceful degradation). harness `get_goal`/`update_goal` collide with pi-multiloop's quick-goal tools — never enable both (verified: pi aborts startup with `Tool "get_goal" conflicts`).
2. **Object-form filtering matches manifest entry paths exactly**: an upstream package renaming its entry files silently breaks the filter (the extension just disappears). Diff the tool surface after every `pi update`.

## Personal extras (personal/, optional)

A standalone pi package with zero code dependencies on the main harness, installed separately:

- **`generate_image` tool** (JD Cloud gpt-image2, OpenAI Images-compatible): image-generation requests hit the API, save locally, and insert into the conversation. Config: `JD_IMAGE_*` env vars or `~/.pi/agent/image2.json`
- **`joyspace-md-import` skill**: writes Markdown (with images/tables) into JD JoySpace online docs by driving the Slate editor via Playwright

```bash
# Remove loose global copies first (double registration is a fatal conflict — verified)
mv ~/.pi/agent/extensions/image2.ts ~/.pi/agent/disabled/extensions/ 2>/dev/null
mv ~/.pi/agent/skills/joyspace-md-import ~/.pi/agent/disabled/skills/ 2>/dev/null
pi install /path/to/pi-lamboy-harness/personal
cd /path/to/pi-lamboy-harness/personal/skills/joyspace-md-import/scripts && npm install   # script deps, first time only
```

## Tests

Pure node-level unit tests, no model quota needed (21 suites, 631 assertions):

```bash
npm test                                        # all suites (node tests/run-all.mjs)
npm run typecheck                               # full-package tsc (strict, es2024)
```

or individually:

```bash
node tests/approval-rpc.test.mjs                  # RPC approval fallback (select/confirm) — 21
node tests/ask.test.mjs                           # ask spec/dialog/answers/approval titles — 118
node tests/goal.test.mjs                          # Goal state machine + monotonic restore — 32
node tests/pause-gate.test.mjs                    # pause gate + full-screen render — 54
node tests/permission.test.mjs                    # Permission guard-layer chain — 20
node tests/perf-adapter.test.mjs                  # perf adapter mock-ssh full chain — 9
node tests/perf-parsers.test.mjs                  # torch profiler + stdout bench extractor — 10
node tests/perf-remote.test.mjs                   # ssh command assembly snapshot — 15
node tests/perf-stats.test.mjs                    # quantiles/MAD/outliers/Mann-Whitney/compare — 11
node tests/plan.test.mjs                          # Plan mode round-trip + restore validation — 37
node tests/shell-output.test.mjs                  # output sanitizer — 21
node tests/shimmer.test.mjs                       # shimmer sweep engine — 10
node tests/stream-rules.test.mjs                  # stream entry rules — 14
node tests/todo.test.mjs                          # todo model + folding strategy + claim/release — 117
node tests/truncation.test.mjs                    # tool-result spill + window-aware threshold — 21
node tests/tui-adapter.test.mjs                   # TUI adapter working-state render path — 4
node tests/tui-box.test.mjs                       # TUI box/config/probe/switch — 63
node tests/tui.test.mjs                           # TUI collapse/keys/completions/spinner — 36
node tests/latex-parse.test.mjs                    # tectonic log parser — 15
node tests/latex-bib.test.mjs                      # bib consistency + fixtures — 4
node tests/latex-adapter.test.mjs                  # latex tools + /compile (mock tectonic) — 11
```

The suites run on Node 22/24/26 (22.6–22.17 via
`--experimental-strip-types`, older legs via `tests/ts-esm-loader.mjs`; 22.18+
strips types natively).

## Roadmap

- ~~**Minimal set v0.1**~~ ✅ Done (2026-09-06): multi-entry refactor + presets mechanism + personal package (decision chain: `plans/2026-09-06-packages-ecosystem-audit.md` → `2026-09-06-restructure-briefing.md` → `2026-09-06-minimal-preset-plan.md` → `plans/minimal.v0.1.md`)
- **i18n** — bilingual harness UI text and notifications (docs are already split en/zh-CN)
- **Math renderer graduation** — merge `feature/math-renderer` once compaction-path context safety is confirmed
- **Clustered diff preview** — ±3-line clustered diffs in edit/write approval messages (deferred from the P1 batch)
- **explore-sync** — distill experiment history into the pi-research knowledge store (roadmap §6.3 carry-over)

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
