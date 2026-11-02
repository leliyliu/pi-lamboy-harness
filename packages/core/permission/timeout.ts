// ============================================================
// Approval Idle Timeout — 人不在屏幕前时，阻塞面板等够时间自动推进。
//
// 背景：yolo/auto 下 destructive / 敏感文件 / .git / 计划审批仍会弹面板
// （policies.ts 的守卫，刻意保留）。人离开后 agent 会一直停在那里。这里提供
// 统一的「空闲超时」契约：
//   - 阈值来自 permissions.json 的 approvalTimeout（可用 env / /mode timeout 覆盖）
//   - 只在配置的模式（默认 yolo + auto）生效，manual 保持"必须有人"
//   - destructive 用更长的阈值（人更可能回来）
//
// 纯逻辑模块，零 pi 依赖，可被 permission / plan / ask 三处复用。
//
// 关键点：不能直接用 pi 内置的 `opts.timeout` —— `ctx.ui.select` 的超时与用户
// Esc 都返回 undefined，无法区分「超时该放行」与「用户明确取消」；而授权面板
// 走的是 ctx.ui.custom，压根没有 timeout 选项。所以统一用自建 AbortController
// 终止面板 + flag 区分来源（runDialogWithTimeout）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionMode } from './types.ts';

/** Which blocking surface is timing out. */
export type TimeoutTarget = 'approval' | 'approval-destructive' | 'plan' | 'ask';

export interface ApprovalTimeoutConfig {
  enabled: boolean;
  /** Permission modes the timeout applies to. */
  modes: PermissionMode[];
  /** Default window: permission ask (non-destructive), plan review, ask tool. */
  defaultMs: number;
  /** Longer window for destructive asks (rm -rf / --force / git reset --hard …). */
  destructiveMs: number;
}

export const APPROVAL_TIMEOUT_DEFAULTS: ApprovalTimeoutConfig = {
  enabled: true,
  modes: ['yolo', 'auto'],
  defaultMs: 5 * 60_000,
  destructiveMs: 15 * 60_000,
};

const VALID_MODES: PermissionMode[] = ['manual', 'auto', 'yolo'];

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * Resolve the timeout config: defaults ← global permissions.json ←
 * project permissions.json ← env overrides.
 *
 * Not on a hot path: read once per blocking dialog, so no mtime cache.
 */
export function loadApprovalTimeoutConfig(cwd: string = process.cwd()): ApprovalTimeoutConfig {
  const config: ApprovalTimeoutConfig = {
    enabled: APPROVAL_TIMEOUT_DEFAULTS.enabled,
    modes: [...APPROVAL_TIMEOUT_DEFAULTS.modes],
    defaultMs: APPROVAL_TIMEOUT_DEFAULTS.defaultMs,
    destructiveMs: APPROVAL_TIMEOUT_DEFAULTS.destructiveMs,
  };

  const home = process.env.HOME || process.env.USERPROFILE || '.';
  for (const file of [
    path.join(home, '.pi', 'agent', 'permissions.json'),
    path.join(cwd, '.pi', 'permissions.json'),
  ]) {
    const parsed = readJson(file);
    const section = parsed?.approvalTimeout;
    if (!section || typeof section !== 'object') continue;
    if (typeof section.enabled === 'boolean') config.enabled = section.enabled;
    if (Array.isArray(section.modes)) {
      // An explicitly empty list means "no mode auto-approves" — honour it
      // instead of silently falling back to the defaults.
      const modes = section.modes
        .map((m: unknown) => (typeof m === 'string' ? m.toLowerCase() : ''))
        .filter((m: string): m is PermissionMode => VALID_MODES.includes(m as PermissionMode));
      config.modes = modes;
    }
    const def = positiveInt(section.defaultMs);
    if (def !== undefined) config.defaultMs = def;
    const dest = positiveInt(section.destructiveMs);
    if (dest !== undefined) config.destructiveMs = dest;
  }

  const envDefault = positiveInt(process.env.PI_APPROVAL_TIMEOUT_MS);
  if (envDefault !== undefined) config.defaultMs = envDefault;
  const envDestructive = positiveInt(process.env.PI_DESTRUCTIVE_TIMEOUT_MS);
  if (envDestructive !== undefined) config.destructiveMs = envDestructive;

  return config;
}

/**
 * Session-scoped override (set by `/mode timeout …`).
 * `null` = follow the config; `0` = disabled for this session.
 * Container object instead of `export let` — jiti 2.7.0 snapshots
 * cross-module live bindings (same reason as permissionModeState).
 */
export const timeoutSessionOverride: { ms: number | null } = { ms: null };

export function setSessionTimeoutOverride(ms: number | null): void {
  timeoutSessionOverride.ms = ms;
}

/**
 * Timeout for a blocking surface, or undefined when it should not time out
 * (disabled / mode not covered / zero window) — undefined always means
 * "keep the old blocking behaviour".
 */
export function approvalTimeoutFor(
  target: TimeoutTarget,
  mode: PermissionMode,
  cfg?: ApprovalTimeoutConfig,
): number | undefined {
  const config = cfg ?? loadApprovalTimeoutConfig();
  if (!config.enabled) return undefined;
  if (!config.modes.includes(mode)) return undefined;
  const override = timeoutSessionOverride.ms;
  if (override === 0) return undefined;
  const ms = override !== null
    ? override
    : target === 'approval-destructive'
      ? config.destructiveMs
      : config.defaultMs;
  return ms > 0 ? ms : undefined;
}

/** Human duration: 5m00s / 45s / 15m00s. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m00s` : `${m}m${String(s).padStart(2, '0')}s`;
}

/** Countdown display: 4:32 / 14:05 / 1:02:03. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface TimedDialogResult<T> {
  value: T | undefined;
  /** Timer fired AND the host produced no value ("nobody answered"). */
  timedOut: boolean;
  /**
   * Timer fired, whatever the host returned afterwards. Needed for boolean
   * dialogs: `confirm()` resolves `false` on abort (pi: `result === "Yes"`,
   * dist/modes/interactive/interactive-mode.js:1967-1969; RPC defaults to
   * false), so a pure `value === undefined` check can never see a timeout
   * there. String dialogs should keep using `timedOut` (a late real answer
   * must win over the timer).
   */
  aborted: boolean;
}

/**
 * Run a dialog primitive (select/confirm/input) under an idle timeout.
 *
 * pi dialogs accept `{ signal }` and dismiss on abort, so the timer both
 * closes the panel and lets us tell "nobody answered" apart from "user
 * pressed Esc" — the distinction the built-in `{ timeout }` option loses.
 */
export async function runDialogWithTimeout<T>(
  run: (opts: { signal?: AbortSignal }) => Promise<T | undefined>,
  timeoutMs: number | undefined,
  parentSignal?: AbortSignal,
): Promise<TimedDialogResult<T>> {
  if (!timeoutMs || timeoutMs <= 0) {
    try {
      return { value: await run({ signal: parentSignal }), timedOut: false, aborted: false };
    } catch {
      return { value: undefined, timedOut: false, aborted: false };
    }
  }

  const controller = new AbortController();
  let fired = false;
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, timeoutMs);
  (timer as any)?.unref?.();

  try {
    const value = await run({ signal: controller.signal });
    // A host that ignores the abort may still deliver a real answer: keep it.
    return { value, timedOut: fired && value === undefined, aborted: fired };
  } catch {
    return { value: undefined, timedOut: fired, aborted: fired };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
