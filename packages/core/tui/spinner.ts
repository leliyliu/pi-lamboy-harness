// ============================================================
// Spinner animation primitives — migrated from core/swarm/helpers (swarm removed 2026-02).
// Pure logic, no host imports.
// ============================================================

export const SPINNER_STYLES: Record<string, string[]> = {
  // Classic braille rotation (default) — single-width, no layout jitter.
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  // Braille dot pulse — grow/shrink breathing.
  pulse: ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿", "⣷", "⣶", "⣦", "⣤", "⣄"],
  // Dot bouncing across a braille cell.
  bounce: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  // Legacy Kimi Code moon phases (double-width emoji).
  moon: ["\uD83C\uDF11", "\uD83C\uDF12", "\uD83C\uDF13", "\uD83C\uDF14", "\uD83C\uDF15", "\uD83C\uDF16", "\uD83C\uDF17", "\uD83C\uDF18"],
};

export const DEFAULT_SPINNER_STYLE = "braille";

// Single-entry memo: resolved once per PI_MUSELINN_SPINNER value; the widget
// calls this every frame, so the env lookup must not hit process.env parsing
// or object allocation on the hot path.
let spinnerCache: { key: string; frames: string[] } | null = null;

/** Active spinner frames: PI_MUSELINN_SPINNER env, else braille. */
export function getSpinnerFrames(): string[] {
  const key = (process.env.PI_MUSELINN_SPINNER || DEFAULT_SPINNER_STYLE).toLowerCase();
  if (spinnerCache && spinnerCache.key === key) return spinnerCache.frames;
  const frames = SPINNER_STYLES[key] ?? SPINNER_STYLES[DEFAULT_SPINNER_STYLE];
  spinnerCache = { key, frames };
  return frames;
}

export const FRAME_INTERVAL_MS = 250;
