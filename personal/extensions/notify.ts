/**
 * notify.ts v6 — 声音 + 自绘浮窗弹窗（2026-10-22 第六轮：需要用户介入时提醒）
 *
 * 通道实证（累积四轮，见 plans/2026-10-12-通知链路诊断报告.md）：
 *   - v1 OSC 99 写 stdout        → 被 pi TUI 渲染层吞掉
 *   - v3 OSC 写 /dev/tty         → 到达 Paseo 内嵌 xterm.js，不被处理
 *   - v2 osascript display notification → 投递被授权闸门拦，但**仍返回 exit 0**（假成功！）
 *   - v4 afplay                  → 无需授权，唯一开箱即用的通道
 *   - v5 自绘 NSPanel 浮窗        → 不经 UNUserNotificationCenter，绕开授权闸门；
 *                                   CGWindowListCopyWindowInfo 实测可见
 *                                   （owner=pinotify layer=25 348x88 @ 右上角）
 *   - v5 osascript display dialog → 非通知中心路径，实测真弹出（作为回落）
 *
 * 通道优先级（fail-open，逐级回落）：
 *   1. pinotify 浮窗（~/.pi/agent/bin/pinotify）——不抢焦点、鼠标穿透、自动淡出
 *   2. osascript "display dialog ... giving up after 5"——pinotify 缺失/启动失败时
 *   3. 仅声音（afplay）+ 日志
 *
 * 触发矩阵：
 *   - agent_settled          → ✅ 完成 / ❌ 出错（aborted 静默）
 *   - 提问 ask_user_question  → ❓ 需要你回答（Ping）
 *   - 权限授权（ask 分支）     → 🔐 需要授权（Submarine）
 *   - 计划审批（review 面板）  → 📋 计划待审批（Hero）
 * 后三类由 repo 侧 packages/core/attention 通过 pi.events 的
 * "lamboy:attention" 频道推送（跨扩展 EventBus；repo 每处 emit 前先
 * setAttentionBus(pi.events)）。本扩展只订阅，不 import repo 代码。
 *
 * headless（ctx.mode !== "tui"）全静默；PI_NOTIFY=0 一键禁用。
 * 调试日志 /tmp/pi-notify.log（PI_NOTIFY_DEBUG 可覆盖），行首带 pid；
 * 未设置 PI_NOTIFY_DEBUG 时只记录事件与失败，不写加载横幅。
 *
 * error 检测：message_end 的 stopReason === "error"（与 harness 40-goal.ts:154 同款）。
 * 音色：Glass=正常落定 / Basso=error / Ping=提问 / Submarine=授权 / Hero=计划审批。
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEBUG_PATH = process.env.PI_NOTIFY_DEBUG || "/tmp/pi-notify.log";
const DEBUG_VERBOSE = Boolean(process.env.PI_NOTIFY_DEBUG);
const DISABLED = process.env.PI_NOTIFY === "0";
const PINOTIFY_BIN = process.env.PINOTIFY_BIN || join(homedir(), ".pi/agent/bin/pinotify");
const POPUP_SECONDS = "6";

/** Must match packages/core/attention/index.ts ATTENTION_CHANNEL. */
const ATTENTION_CHANNEL = "lamboy:attention";

/** Attention kind → { sound, popup kind }. Env overrides: PI_NOTIFY_SOUND_<KIND>. */
const ATTENTION_STYLE: Record<string, { sound: string; popup: "success" | "error" | "info" }> = {
  ask: { sound: "Ping", popup: "info" },
  approval: { sound: "Submarine", popup: "info" },
  plan: { sound: "Hero", popup: "info" },
};

function debug(msg: string): void {
  try {
    // 带 pid：/tmp/pi-notify.log 由多个 pi 进程共享 append，无 pid 时旧版与新记录混杂难辨
    appendFileSync(DEBUG_PATH, `[${new Date().toISOString()}] [${process.pid}] ${msg}\n`);
  } catch {
    // 日志失败不打断 agent
  }
}

function playSound(sound: string): void {
  // afplay 无需通知授权；execFile 子进程，不触碰 TUI stdout
  execFile("afplay", [`/System/Library/Sounds/${sound}.aiff`], (err) => {
    debug(`afplay ${sound} exit=${err ? `FAIL ${err.message}` : "0"}`);
  });
}

/** AppleScript 字符串转义。 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 回落通道：AppleScript 模态对话框（非通知中心，实测可用）。 */
function dialogFallback(title: string, body: string): void {
  execFile(
    "osascript",
    ["-e", `display dialog "${esc(body)}" with title "${esc(title)}" giving up after 5`],
    (err) => debug(`dialog fallback exit=${err ? `FAIL ${err.message}` : "0"}`),
  );
}

/**
 * 弹窗：优先自绘浮窗，失败回落对话框。
 * 注意 spawn 是异步 fire-and-forget：ENOENT 等启动错误通过 error 事件回落。
 */
function popup(kind: "success" | "error" | "info", title: string, body: string): void {
  if (existsSync(PINOTIFY_BIN)) {
    try {
      const child = spawn(
        PINOTIFY_BIN,
        ["--title", title, "--body", body, "--kind", kind, "--duration", POPUP_SECONDS],
        { detached: true, stdio: "ignore" },
      );
      child.on("error", (err) => {
        debug(`pinotify spawn FAIL ${err.message} → dialog fallback`);
        dialogFallback(title, body);
      });
      child.unref();
      debug(`pinotify spawned kind=${kind}`);
      return;
    } catch (err: any) {
      debug(`pinotify throw ${err?.message} → dialog fallback`);
    }
  } else {
    debug(`pinotify missing (${PINOTIFY_BIN}) → dialog fallback`);
  }
  dialogFallback(title, body);
}

/** 压平 + 截断。 */
function truncate(text: string, limit = 140): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

function formatElapsed(ms: number): string | null {
  const s = Math.round(ms / 1000);
  if (s < 1) return null; // 亚秒级不展示，避免出现 "· 0s"
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;
  if (DEBUG_VERBOSE) {
    debug(`notify v6 loaded pid=${process.pid} pinotify=${existsSync(PINOTIFY_BIN) ? PINOTIFY_BIN : "MISSING"}`);
  }

  // ── Attention receiver: repo emits right before a blocking dialog ──
  // pi.events wraps handlers in try/catch, so a throw here cannot reach the
  // dialog flow; the inner try/catch only guards our own logging.
  const notifier = (payload: unknown) => {
    try {
      const req = (payload ?? {}) as { kind?: string; title?: string; body?: string };
      const kind = String(req.kind ?? "ask");
      const style = ATTENTION_STYLE[kind] ?? ATTENTION_STYLE.ask;
      const sound = process.env[`PI_NOTIFY_SOUND_${kind.toUpperCase()}`] || style.sound;
      const body = truncate(String(req.body ?? ""));
      debug(`attention kind=${kind} title=${req.title ?? ""} body=${truncate(body, 60)}`);
      playSound(sound);
      popup(style.popup, String(req.title ?? "pi"), body);
    } catch (err: any) {
      debug(`attention notifier FAIL ${err?.message ?? err}`);
    }
  };
  const off = pi.events.on(ATTENTION_CHANNEL, notifier);
  pi.on("session_shutdown", async () => {
    // Belt and braces: the loader already tracks/clears event subscriptions on
    // reload, but an explicit unsubscribe keeps a re-loaded extension from
    // double-firing.
    try {
      off?.();
    } catch {
      /* already detached */
    }
  });

  let lastError: string | null = null;
  let runStart: number | null = null;

  // 缓存本 run 最后一条 assistant 错误，供 settled 分文案。
  pi.on("message_end", async (event: any) => {
    const msg = event?.message;
    if (runStart === null) runStart = Date.now();
    if (msg?.role === "assistant" && msg?.stopReason === "error") {
      lastError = truncate(String(msg?.errorMessage || msg?.content || "unknown error"));
    } else if (msg?.role === "assistant") {
      lastError = null;
    }
  });

  // agent_settled 是最终态：之后 pi 不会再自动继续。
  pi.on("agent_settled", async (event: any, ctx: any) => {
    if (ctx?.mode && ctx.mode !== "tui") return; // headless/pipe 静默
    const elapsed = runStart ? formatElapsed(Date.now() - runStart) ?? "" : "";
    const project = ctx?.cwd ? basename(ctx.cwd) : "";
    const title = project ? `pi · ${project}` : "pi";
    debug(`settled mode=${ctx?.mode ?? "?"} aborted=${!!event?.aborted} err=${!!lastError} elapsed=${elapsed}`);

    if (event?.aborted) {
      // 用户主动中止，不需要提醒
    } else if (lastError) {
      playSound("Basso");
      popup("error", title, `❌ 出错：${lastError}${elapsed ? ` · ${elapsed}` : ""}`);
    } else {
      playSound("Glass");
      popup("success", title, `✅ 完成，可以输入了${elapsed ? ` · ${elapsed}` : ""}`);
    }
    lastError = null;
    runStart = null;
  });
}
