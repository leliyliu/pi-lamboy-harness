// ============================================================
// Pause screen layout（纯逻辑，无终端依赖）。
// 全屏遮罩：内容垂直居中；背景由终端背景自然呈现（纯空格
// 覆盖底层内容），文字/图标颜色通过 style 注入的主题色渲染
// （默认固定 ANSI 兜底，供无主题环境的单测使用）。
// ============================================================

/** 主题色包装器（适配层注入 theme.fg(...) 等；默认固定 ANSI）。 */
export interface PauseScreenStyle {
  accent(s: string): string;
  text(s: string): string;
  muted(s: string): string;
  dim(s: string): string;
}

/** 默认样式：深灰底 + 琥珀图标 + 浅灰文字（omp 同款，单测/无主题兜底）。 */
export const defaultPauseScreenStyle: PauseScreenStyle = {
  accent: (s) => `\x1b[38;2;255;159;67m${s}\x1b[39m`,
  text: (s) => `\x1b[38;2;214;214;220m${s}\x1b[39m`,
  muted: (s) => `\x1b[38;2;168;168;176m${s}\x1b[39m`,
  dim: (s) => `\x1b[38;2;128;128;138m${s}\x1b[39m`,
};

/** Pause-bar glyph geometry (rows × columns of full blocks per bar). */
const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;

/** Below either bound the full scene cannot breathe; drop to the compact card. */
const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;

/** `Ns` / `Nm ss` / `Hh Mm` — seconds with two-digit padding. */
export function formatPauseDuration(durMs: number): string {
  const s = Math.floor(durMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Live hold clock, seconds-precise: `0:07`, `12:34`, `1:02:03`. */
export function formatPauseClock(durMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** East Asian Wide/Fullwidth code points render as 2 columns in terminal fonts.
 *  Block glyphs (█ U+2588) and symbols (⏸ U+23F8) are single-width — counting
 *  them as wide shifts centered content left. */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals … Yi (incl. CJK punct)
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B+
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

/** Display width: East Asian Wide/Fullwidth glyphs count as 2 columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWideChar(ch.codePointAt(0)!) ? 2 : 1;
  }
  return w;
}

/**
 * Paint one overlay row: `width` columns of plain spaces (terminal
 * background shows through as the backdrop) with a horizontally
 * centered, styled text slice.
 */
function paint(text: string, color: ((s: string) => string) | undefined, width: number): string {
  const pad = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  const tail = Math.max(0, width - pad - displayWidth(text));
  return " ".repeat(pad) + (color ? color(text) : text) + " ".repeat(tail);
}

/** Blank backdrop row (spaces cover the base line; terminal bg = backdrop). */
function blank(width: number): string {
  return " ".repeat(width);
}

/**
 * Build the full-screen pause scene as exactly `height` rows: a solid
 * backdrop (terminal background) with vertically centered content.
 * `pausedOrigin` renders a small context tag (e.g. `<tool_call>` when
 * the pause was triggered mid-tool).
 */
export function renderPauseScreen(o: {
  width: number;
  height: number;
  pausedAt: number;
  nowMs: number;
  pausedOrigin?: string;
  style?: PauseScreenStyle;
}): string[] {
  const style = o.style ?? defaultPauseScreenStyle;
  const width = o.width < 20 ? 20 : o.width;
  const height = Math.max(1, Math.floor(o.height));
  const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
  const elapsed = formatPauseClock(Math.max(0, o.nowMs - o.pausedAt));

  const content: string[] = [];
  if (o.pausedOrigin === "tool_call") {
    content.push(paint("<tool_call>", style.dim, width));
    content.push(blank(width));
  }
  if (!compact) {
    const bar = "█".repeat(BAR_WIDTH);
    const glyphRow = `${bar}${" ".repeat(BAR_GAP)}${bar}`;
    for (let i = 0; i < BAR_ROWS; i++) {
      content.push(paint(glyphRow, style.accent, width));
    }
    content.push(blank(width));
  }
  content.push(paint("⏸ PAUSED", style.text, width));
  content.push(blank(width));
  if (!compact) {
    content.push(paint("主代理、子代理与顾问将在下一步暂停", style.muted, width));
    content.push(paint("进行中的调用完成后不再启动新任务", style.muted, width));
    content.push(blank(width));
  }
  content.push(paint(`paused for ${elapsed}`, style.muted, width));
  content.push(blank(width));
  content.push(paint("esc/enter/space/ctrl+c 释放", style.dim, width));

  // Vertically center the whole block; when a small terminal forces the
  // compact card, nudge slightly upward so the scene stays readable.
  const topPad =
    compact && height > 12
      ? Math.max(0, Math.floor((height - content.length) / 3))
      : Math.max(0, Math.floor((height - content.length) / 2));
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const idx = i - topPad;
    lines.push(idx >= 0 && idx < content.length ? content[idx] : blank(width));
  }
  return lines;
}
