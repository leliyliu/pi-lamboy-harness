// ============================================================
// TUI — Runtime wiring: boxed/compact editor chrome, /tui command,
// working spinner.
//
// Performance rules (see README): the spinner timer only runs while the
// agent is working; event handlers only assign state + requestRender on
// actual change; all formatting happens lazily inside render().
// Verified against pi-tui (dist/tui.js): requestRender() is coalesced via
// a renderRequested flag and capped at MIN_RENDER_INTERVAL_MS=16, and each
// doRender re-renders the whole component tree — so the only marginal cost
// we can add is *extra* full-tree renders after quiet gaps; avoid them.
// ============================================================

import { type EditorStyle } from "../packages/core/tui/box";
import { shouldKeepAliveRender, wallClockFrameIndex, KEEP_ALIVE_QUIET_MS, KEEP_ALIVE_INTERVAL_MS } from "../packages/core/tui/keepalive";
import { shimmerText, type ShimmerMode } from "../packages/core/tui/shimmer";
import { loadTuiConfig, saveTuiConfig, type TuiConfig } from "../packages/core/tui/config";
import { MuselinnEditor } from "./editor";
import { parseTuiArgs } from "../packages/core/tui/parse";
import { planStyleSwitch } from "../packages/core/tui/switch";
import { renderTiming, isTimingEnabled } from "../packages/core/tui/timing";
import { tuiArgumentCompletions } from "../packages/core/completions";
import { getSpinnerFrames, FRAME_INTERVAL_MS } from "../packages/core/tui/spinner";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

interface TuiRuntime {
  pi: ExtensionAPI | null;
  ctx: ExtensionContext | null;
  tui: TUI | null;
  style: EditorStyle;
  modelInBorder: boolean;
  /** Loaded shimmer mode (classic | kitt | disabled). */
  shimmer: "classic" | "kitt" | "disabled";
  editor: MuselinnEditor | null;
  working: boolean;
  workingMessage: string | undefined;
  runningTools: Set<string>;
  /** Wall-clock of the last pi render observed via the editor probe. */
  lastRenderAt: number;
  spinnerTimer: ReturnType<typeof setInterval> | null;
}

const rt: TuiRuntime = {
  pi: null,
  ctx: null,
  tui: null,
  style: "boxed",
  modelInBorder: false,
  shimmer: "classic",
  editor: null,
  working: false,
  workingMessage: undefined,
  runningTools: new Set(),
  lastRenderAt: 0,
  spinnerTimer: null,
};

// ── Shimmer ANSI resolver ─────────────────────────────────────
// The compiled-palette cache in shimmer.ts is keyed on the resolver object
// identity — allocating a fresh resolver per render would defeat it (every
// frame would re-resolve ANSI for each palette tier). Reuse one resolver
// per Theme instance; the cache auto-invalidates when pi swaps themes
// (ctx.ui.theme returns the current Theme).
let shimmerResolverFor: any = null;
let shimmerResolver: { fgAnsi(color: string): string } | null = null;
function getShimmerResolver(theme: any): { fgAnsi(color: string): string } {
  if (shimmerResolverFor !== theme) {
    shimmerResolverFor = theme;
    shimmerResolver = { fgAnsi: (color) => theme.getFgAnsi(color as any) };
  }
  return shimmerResolver!;
}

// ── Border slots ──────────────────────────────────────────────

/**
 * Optional badge for the top border's left slot (e.g. plan mode).
 * Injected by the host (index.ts) so the tui module stays decoupled
 * from plan/permission internals. Evaluated lazily per render — the
 * provider must be a cheap in-memory check.
 */
let badgeProvider: (() => string | undefined) | null = null;

export function setTuiBadgeProvider(fn: (() => string | undefined) | null): void {
  badgeProvider = fn;
}

function slotLeft(): string {
  const ctx = rt.ctx;
  if (!ctx) return "";
  const theme = ctx.ui.theme;
  const parts: string[] = [];
  let badge: string | undefined;
  try { badge = badgeProvider?.() ?? undefined; } catch { badge = undefined; }
  if (badge) parts.push(theme.fg("warning", badge));
  if (rt.working) {
    const frames = getSpinnerFrames();
    // Wall-clock frame: the spinner advances whenever pi renders for any
    // reason (streaming deltas drive plenty), so the keep-alive timer below
    // only needs to cover quiet gaps — not drive the animation itself.
    const frame = frames[wallClockFrameIndex(frames.length, Date.now(), FRAME_INTERVAL_MS)];
    parts.push(theme.fg("accent", frame));
    if (rt.workingMessage) {
      // Shimmer sweep (OMP-style): the band's crest paints accent+bold, so
      // the dim message stays legible exactly where the light passes — no
      // need for brighter idle colors. Wall-clock driven, so it stays smooth
      // even when the agent loop stalls a render.
      const mode = rt.shimmer;
      if (mode !== "disabled") {
        parts.push(
          shimmerText(
            rt.workingMessage,
            getShimmerResolver(theme),
            mode as ShimmerMode,
            Date.now(),
          ),
        );
      } else {
        parts.push(theme.fg("dim", rt.workingMessage));
      }
    }
  }
  return parts.join(" ");
}

function slotRight(): string {
  const ctx = rt.ctx;
  if (!ctx || !rt.modelInBorder) return "";
  const theme = ctx.ui.theme;
  const provider = ctx.model?.provider;
  const id = ctx.model?.id;
  if (!provider && !id) return "";
  let level = "";
  try {
    const l = (rt.pi?.getThinkingLevel?.() ?? "") as string;
    level = l && l !== "off" ? `:${l}` : "";
  } catch { /* older pi without getThinkingLevel */ }
  return theme.fg("dim", [provider, `${id ?? ""}${level}`].filter(Boolean).join(" · "));
}

// ── Style application (ui-injectable for tests) ───────────────

interface TuiUiLike {
  setEditorComponent(factory: any): void;
  setWorkingVisible(visible: boolean): void;
}

/**
 * Apply an editor chrome style. plain unregisters the custom editor so
 * pi's default editor returns; boxed/compact register a fresh factory
 * (pi hot-swaps, preserving text/focus/keybindings).
 */
export function applyStyleToUi(ui: TuiUiLike, style: EditorStyle): void {
  rt.style = style;
  const plan = planStyleSwitch(style);
  ui.setWorkingVisible(plan.workingVisible);
  if (!plan.registerFactory) {
    rt.editor = null;
    ui.setEditorComponent(undefined);
    return;
  }
  ui.setEditorComponent((tui: TUI, theme: any, keybindings: any) => {
    rt.tui = tui;
    rt.editor = new MuselinnEditor(
      tui,
      theme,
      keybindings,
      style,
      { left: slotLeft, right: slotRight },
      isTimingEnabled() ? renderTiming : null,
      () => { rt.lastRenderAt = performance.now(); },
    );
    return rt.editor;
  });
}

// ── Spinner lifecycle ─────────────────────────────────────────

function stopSpinner(): void {
  if (rt.spinnerTimer) {
    clearInterval(rt.spinnerTimer);
    rt.spinnerTimer = null;
  }
}

function startSpinner(): void {
  stopSpinner();
  // Keep-alive only: pi-tui re-renders the WHOLE component tree per frame,
  // which at high context costs real milliseconds. The animation itself
  // rides on pi's natural renders (wall-clock frame in slotLeft); this
  // timer exists solely to cover quiet gaps (long tool executions with no
  // streaming).
  //
  // Fixed gate (not adaptive): a constant 200ms quiet threshold keeps the
  // keep-alive cadence stable at ~10fps. Adaptive thresholds based on
  // measured render latency were tried and removed — request→render
  // latency is noisy (async coalescing, GC, terminal I/O), and any single
  // spike raised the threshold for a second or more, making the animation
  // visibly stutter right after the spike even on fast sessions.
  rt.spinnerTimer = setInterval(() => {
    if (!shouldKeepAliveRender(rt.working, rt.lastRenderAt, performance.now())) return;
    try { rt.tui?.requestRender(); } catch { /* stale tui */ }
  }, KEEP_ALIVE_INTERVAL_MS);
}

function setWorking(working: boolean, message?: string): void {
  // Skip no-op updates: streaming deltas and tool bursts re-assert the same
  // (working, message) pair dozens of times per second. pi-tui coalesces
  // requestRender() calls anyway (renderRequested flag + 16ms cap), but a
  // no-op call arriving after a >16ms quiet gap would still force a full
  // component-tree re-render for zero visible change.
  if (rt.working === working && rt.workingMessage === message) return;
  rt.working = working;
  rt.workingMessage = message;
  try { rt.tui?.requestRender(); } catch { /* stale tui */ }
}

// ── Config helpers ────────────────────────────────────────────

function persistConfig(): void {
  const config: TuiConfig = { style: rt.style, modelInBorder: rt.modelInBorder, shimmer: rt.shimmer };
  saveTuiConfig(config);
}

// ── Registration ──────────────────────────────────────────────

export function registerTui(pi: ExtensionAPI): void {
  rt.pi = pi;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    rt.ctx = ctx;

    let config: TuiConfig;
    try {
      config = loadTuiConfig(ctx.sessionManager.getCwd());
    } catch {
      config = { style: "boxed", modelInBorder: false, shimmer: "classic" };
    }

    // Reset per-session working state before re-applying chrome.
    rt.working = false;
    rt.workingMessage = undefined;
    rt.runningTools.clear();
    rt.lastRenderAt = 0;
    rt.modelInBorder = config.modelInBorder;
    rt.shimmer = config.shimmer;

    applyStyleToUi(ctx.ui, config.style);
  });

  pi.on("agent_start", () => {
    rt.runningTools.clear();
    setWorking(true, undefined);
    startSpinner();
  });

  pi.on("message_update", (event: any) => {
    if (rt.runningTools.size > 0) return;
    switch (event?.assistantMessageEvent?.type) {
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        setWorking(true, "Thinking");
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
        setWorking(true, "Streaming");
        break;
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        setWorking(true, "Running tools");
        break;
      default:
        break;
    }
  });

  pi.on("tool_execution_start", (event: any) => {
    if (event?.toolCallId) rt.runningTools.add(event.toolCallId);
    setWorking(true, "Running tools");
  });

  pi.on("tool_execution_end", (event: any) => {
    if (event?.toolCallId) rt.runningTools.delete(event.toolCallId);
    setWorking(true, rt.runningTools.size > 0 ? "Running tools" : undefined);
  });

  pi.on("agent_end", () => {
    rt.runningTools.clear();
  });

  pi.on("agent_settled", () => {
    rt.runningTools.clear();
    setWorking(false, undefined);
    stopSpinner();
  });

  pi.on("session_shutdown", () => {
    stopSpinner();
    rt.ctx = null;
    rt.tui = null;
    rt.editor = null;
    rt.working = false;
    rt.workingMessage = undefined;
    rt.runningTools.clear();
  });

  pi.registerCommand("tui", {
    description: "Switch editor chrome (boxed editor)",
    getArgumentCompletions: (prefix: string) => tuiArgumentCompletions(prefix),
    handler: async (args: string, ctx: any) => {
      if (!ctx?.hasUI) return;
      const cmd = parseTuiArgs(args);

      switch (cmd.kind) {
        case "status": {
          const lines = [
            `tui: style=${rt.style} · modelInBorder=${rt.modelInBorder} · shimmer=${rt.shimmer}`,
            "",
            "usage:",
            "  /tui                          show this status",
            "  /tui style <plain|boxed|compact>",
            "  /tui shimmer <classic|kitt|disabled>   working-message sweep",
            "  /tui timing                   render timing (PI_MUSELINN_HARNESS_TUI_TIMING=1)",
          ];
          if (isTimingEnabled()) lines.push(renderTiming.format());
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "style": {
          applyStyleToUi(ctx.ui, cmd.style);
          persistConfig();
          ctx.ui.notify(`tui style: ${cmd.style}`, "info");
          break;
        }
        case "shimmer": {
          rt.shimmer = cmd.shimmer;
          persistConfig();
          try { rt.tui?.requestRender(); } catch { /* stale tui */ }
          ctx.ui.notify(`tui shimmer: ${cmd.shimmer}`, "info");
          break;
        }
        case "timing": {
          if (!isTimingEnabled()) {
            ctx.ui.notify("timing is off — restart pi with PI_MUSELINN_HARNESS_TUI_TIMING=1", "info");
          } else {
            ctx.ui.notify(renderTiming.format(), "info");
          }
          break;
        }
        case "error": {
          ctx.ui.notify(cmd.message, "error");
          break;
        }
      }
    },
  });
}

// Test-only access to the runtime state.
export const __tuiRuntime = rt;
