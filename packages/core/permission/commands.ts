// ============================================================
// Permission Commands — /mode
// ============================================================

import type { PermissionManager } from './index.ts';
import type { PermissionMode } from './types.ts';
import {
  approvalTimeoutFor,
  formatDuration,
  loadApprovalTimeoutConfig,
  setSessionTimeoutOverride,
  timeoutSessionOverride,
} from './timeout.ts';
import { modeArgumentCompletions } from '../completions.ts';

/** Parse "5m" / "90s" / "300000" (ms) / "0" into ms; undefined when invalid. */
function parseDurationArg(raw: string): number | undefined {
  const text = raw.trim().toLowerCase();
  if (!text) return undefined;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = match[2] ?? 'ms';
  const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
  return Math.round(n * factor);
}

function timeoutSummary(mode: PermissionMode): string {
  const cfg = loadApprovalTimeoutConfig();
  const override = timeoutSessionOverride.ms;
  if (override === 0) {
    return 'off for this session (/mode timeout reset to restore)';
  }
  const normal = approvalTimeoutFor('approval', mode, cfg);
  const destructive = approvalTimeoutFor('approval-destructive', mode, cfg);
  if (!normal && !destructive) {
    return cfg.enabled
      ? `off in ${mode} mode (active modes: ${cfg.modes.length > 0 ? cfg.modes.join('/') : 'none'})`
      : 'disabled by config';
  }
  const suffix = override !== null ? ' [session override]' : '';
  return `${formatDuration(normal ?? destructive!)}${suffix} · destructive ${destructive ? formatDuration(destructive) : 'off'}`;
}

export function registerPermissionCommands(pi: any, permissionManager: PermissionManager): void {
  pi.registerCommand("mode", {
    description: "Switch permission mode (auto/yolo/manual)",
    getArgumentCompletions: (prefix: string) => modeArgumentCompletions(prefix),
    handler: async (args: string, ctx: any) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "status" || arg === "") {
        ctx.ui.notify(
          `Permission mode: ${permissionManager.getMode()}\nIdle timeout: ${timeoutSummary(permissionManager.getMode())}`,
          "info",
        );
        return;
      }

      // ── Idle timeout control (/mode timeout [off|on|reset|5m|90s]) ──
      if (arg === "timeout" || arg.startsWith("timeout ")) {
        const value = arg.slice("timeout".length).trim();
        if (!value) {
          ctx.ui.notify(`Idle timeout: ${timeoutSummary(permissionManager.getMode())}`, "info");
          return;
        }
        if (value === "off" || value === "0") {
          setSessionTimeoutOverride(0);
          ctx.ui.notify("Idle timeout disabled for this session.", "warning");
          return;
        }
        if (value === "on" || value === "reset") {
          setSessionTimeoutOverride(null);
          ctx.ui.notify(`Idle timeout reset to config: ${timeoutSummary(permissionManager.getMode())}`, "success");
          return;
        }
        const ms = parseDurationArg(value);
        if (ms === undefined) {
          ctx.ui.notify(`Unknown timeout value: ${value}. Use e.g. 5m, 90s, 300000, off, reset.`, "error");
          return;
        }
        setSessionTimeoutOverride(ms);
        ctx.ui.notify(
          `Idle timeout set to ${formatDuration(ms)} for this session (all surfaces, destructive included).`,
          "success",
        );
        return;
      }

      if (arg === "auto" || arg === "yolo" || arg === "manual") {
        const mode = arg as PermissionMode;
        const prevMode = permissionManager.getMode();
        
        if (mode === prevMode) {
          ctx.ui.notify(`Permission mode is already ${mode}.`, "info");
          return;
        }

        // Confirm mode switch for safety
        if (mode === 'auto' || mode === 'yolo') {
          const confirmed = await ctx.ui.confirm(
            "Mode Switch",
            `Switch to ${mode.toUpperCase()} mode?\n\n${mode === 'auto' ? 'All actions will be auto-approved. AskUserQuestion will be disabled.' : 'Actions will be approved after safety checks (sensitive files, .git still require approval).'}`,
          );
          if (!confirmed) {
            ctx.ui.notify("Mode switch cancelled.", "info");
            return;
          }
        }

        permissionManager.setMode(mode);
        ctx.ui.setStatus("permission-mode", ctx.ui.theme.fg(
          mode === 'auto' ? 'success' : mode === 'yolo' ? 'warning' : 'accent',
          mode
        ));
        ctx.ui.notify(`Permission mode: ${mode.toUpperCase()}`, "success");
        return;
      }

      ctx.ui.notify(`Unknown mode: ${arg}. Use auto, yolo, manual, or timeout.`, "error");
    },
  });
}
