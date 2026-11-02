# Paseo 终端里 pi 滚轮失效：诊断与修复

日期：2026-10-28
状态：已修复（配置层 workaround），上游缺陷仍 open

## 现象

在 Paseo 内置终端里运行 pi，pi 输出之后鼠标滚轮无法向上滚动查看中间结果。
键盘 PageUp / PageDown 可以滚动。

## 诊断（已验证）

1. **运行环境**：pi 由 Paseo daemon 在 pty 中启动

   ```
   36249 30786 ttys012  Ss+  pi
   30786  = Paseo Daemon
   env: PASEO_TERMINAL_ID=fe8607c3-…
   ```

2. **pi 默认 fullscreen**：`tuiMode` 未显式设置 ⇒ 默认 `fullscreen`
   - `pi-tui/dist/tui-alt-screen.js:12` `ENTER_ALT_SCREEN = "\x1b[?1049h"`
   - `:194` 启动时写入 `ENTER_ALT_SCREEN + mouseSequence`，开启鼠标跟踪
     `\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h`

3. **alt-screen 下终端没有 scrollback**，滚轮必须由终端模拟器（Paseo 的 xterm.js）
   转成 SGR mouse report 交给 pi，pi 才能滚动自己的 viewport。

4. **Paseo 这条链路断了**：上游 issue
   [getpaseo/paseo#3809 — Fullscreen TUI does not receive mouse-wheel scrolling events](https://github.com/getpaseo/paseo/issues/3809)
   - 原始报告就是 `pi --tui-mode fullscreen`，症状完全一致（滚轮无效、PageUp/PageDown 有效）
   - 状态：open，p2，2026-08-24 提出，2026-09 有人补充 OpenCode 同样受影响
   - 我核对了 `v0.14.0-beta.1` 的 release notes，无 wheel/mouse 相关修复

## 对照实验（本机实测）

用 pty 分别启动两种模式，抓原始 ANSI 输出：

| 模式 | alt-screen (`\x1b[?1049h`) | mouse 1000h | mouse 1002h |
|---|---|---|---|
| `--tui-mode fullscreen` | 1 | 1 | 1 |
| `--tui-mode regular` | 0 | 0 | 0 |

regular 模式不使用 alt-screen、不开启鼠标跟踪，输出直接进入终端的 scrollback，
滚轮由 Paseo 的 xterm 原生处理。

## 修复（已应用）

`~/.pi/agent/settings.json`：

```json
{ "tuiMode": "regular" }
```

备份：`~/.pi/agent/settings.json.bak-20261028-151002`

生效范围：**新启动**的 pi 会话（当前已运行的 fullscreen 会话不热切换）。

## 相关参数

- Paseo 终端 scrollback 默认 10000 行（`terminalScrollbackLines: 1e4`，
  范围 0–1000000），Settings → Terminal scrollback 可调
- 只想在 Paseo 里用 regular、其他终端保持 fullscreen：
  - Paseo 里启动 `pi --tui-mode regular`
  - iTerm/tmux 里启动 `pi --tui-mode fullscreen`
- 临时切回：`/settings` 里改 TUI mode，或 CLI `--tui-mode`

## fullscreen 模式下的键盘替代（若以后切回）

| 操作 | 键位 |
|---|---|
| 上/下一页 | `PageUp` / `PageDown` |
| 到顶 / 回底 | `Ctrl+Home` / `Ctrl+End` |
| 搜索 transcript | `Ctrl+Shift+F` |
| 上/下一条消息 | `Ctrl+Shift+↑/↓` |

## 后续

若 Paseo 修复 #3809（在终端层把 wheel 转发为 mouse report），可把 `tuiMode` 改回
`fullscreen` 获得固定输入区 + pi 内置搜索/选中复制。

## 验证记录（2026-10-28 15:1x，本轮实测）

### 结论

**当前这个会话里滚轮仍然无效**——不是因为修复失败，而是修复只对新启动会话生效，
本会话是改动前启动的旧进程。

### 证据

| 项 | 实测值 | 含义 |
|---|---|---|
| 当前 pi 进程 | PID 36249，`ttys012`，启动于 `Wed Oct 28 14:32:16 2026` | 早于配置改动 15:10:10 |
| 进程启动参数 | `pi`（无 `--tui-mode`） | 模式取自启动时的 settings |
| 改动前 settings 备份 | `settings.json.bak-20261028-151002` **无** `tuiMode` 字段 | 走 `SETTINGS_DEFAULTS` |
| 默认值源码 | `pi-coding-agent/dist/core/settings-defaults.js:61` `tuiMode: "fullscreen"` | ⇒ 本会话 = fullscreen |
| 终端环境 | `PASEO_TERMINAL_ID=fe8607c3-…`、`__CFBundleIdentifier=sh.paseo.desktop` | 确实在 Paseo 内嵌终端 |
| Paseo 版本 | `0.13.2`（`paseo --version`） | 仍含 #3809 |
| 当前 settings | `"tuiMode": "regular"`（第 4 行） | 新会话会生效 |

### pty 对照实验（本次重跑，脚本 `/tmp/wheel_probe.py`）

`pi --no-session --tui-mode <mode>` 在独立 pty 中启动，抓前 ~6s 原始 ANSI：

| 序列 | fullscreen | regular |
|---|---|---|
| `\x1b[?1049h`（alt-screen） | YES | no |
| `\x1b[?1000h` | YES | no |
| `\x1b[?1002h` | YES | no |
| `\x1b[?1006h`（SGR mouse） | YES | no |
| `\x1b[?25l`（隐藏光标） | YES | YES |

与上文「对照实验」表一致：regular 不开鼠标跟踪，滚轮交回 Paseo 的 xterm.js 原生处理。

### 待人工确认

滚轮本身能否滚，终端侧无法自证，需在**重启后的 pi 会话**里手动滚一次：

```bash
# 在 Paseo 终端里重启
pi            # settings 已是 regular
# 或显式指定
pi --tui-mode regular
```

本会话（fullscreen）内可用 `PageUp` / `PageDown` 滚动。
