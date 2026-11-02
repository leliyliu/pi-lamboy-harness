// ============================================================
// Permission — RPC/limited-UI approval dialog (pure logic, zero pi imports).
//
// pi RPC mode (obsidian-pi & other embedding clients) exposes the extension
// UI protocol (select/confirm/input/notify) but not the TUI-only
// ctx.ui.custom that the full approval dialog renders through. Without this
// fallback every `ask` verdict in manual mode silently degrades to deny
// ("User denied: <policy>") and the user never sees a prompt.
//
// Mirrors the TUI flow over the extension UI primitives: three-way ask
// (once/always/deny) with an optional deny reason; cancelling the reason
// input returns to the options. select() itself failing (older host)
// degrades to a boolean confirm, and that failing degrades to a fail-safe
// deny.
// ============================================================

import type { ApprovalDialogResult } from './index.ts';
import { formatDuration, runDialogWithTimeout } from './timeout.ts';

/** Minimal extension UI surface the fallback needs (subset of pi's
 * ExtensionUIContext — the full ctx type isn't part of the peer dep's
 * public API; see pi packages/coding-agent/src/core/extensions/types.ts). */
export interface ApprovalDialogCtx {
  mode?: string;
  signal?: AbortSignal;
  ui?: {
    select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
    confirm?: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
    input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  };
}

export interface ApprovalRpcOptions {
  /** Idle timeout: nobody answered within this window → allow once. */
  timeoutMs?: number;
}

/**
 * Approval dialog for hosts without ctx.ui.custom (pi RPC mode). `title`
 * may already carry a composed prompt (e.g. the tool action title).
 */
export async function approvalViaRpcUi(
  dialogCtx: ApprovalDialogCtx,
  toolName: string,
  title: string,
  message: string,
  opts?: ApprovalRpcOptions,
): Promise<ApprovalDialogResult> {
  const ui = dialogCtx?.ui;
  const timeoutMs = opts?.timeoutMs;
  // One window per approval, not per re-opened prompt: a Deny→reason→back
  // loop must not restart the clock (the dialog always opens at once).
  const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const remainingMs = () => (deadline ? Math.max(1, deadline - Date.now()) : undefined);
  const hint = timeoutMs ? `\n\n⏰ ${formatDuration(timeoutMs)} 无操作 → 自动放行（仅本次）` : '';
  const prompt = `${title}: ${message}${hint}`;

  // select() unavailable → boolean confirm as a last resort
  if (!ui || typeof ui.select !== 'function') {
    const confirmed = await runDialogWithTimeout(
      (dialogOpts) => (ui && typeof ui.confirm === 'function'
        ? ui.confirm(prompt, `Tool: ${toolName}`, { signal: dialogOpts.signal })
        : Promise.resolve(false)),
      remainingMs(),
      dialogCtx?.signal,
    );
    // confirm() answers false on abort — a timeout is `aborted`, not `undefined`.
    if (confirmed.aborted && confirmed.value !== true) return { decision: 'once', timedOut: true };
    return confirmed.value ? { decision: 'once' } : { decision: 'deny' };
  }

  const options = [
    'Allow once',
    'Always allow (this session)',
    'Deny',
    'Deny with reason',
  ];
  while (true) {
    const picked = await runDialogWithTimeout(
      (dialogOpts) => ui.select!(prompt, options, { signal: dialogOpts.signal }),
      remainingMs(),
      dialogCtx?.signal,
    );
    if (picked.timedOut) return { decision: 'once', timedOut: true };
    const choice = picked.value;
    if (choice === 'Allow once') return { decision: 'once' };
    if (choice === 'Always allow (this session)') return { decision: 'always' };
    if (choice === 'Deny with reason') {
      let reason: string | undefined;
      try {
        reason = (await ui.input?.('Reason for denying (optional)', "e.g. don't force-push to main", { signal: dialogCtx?.signal })) || undefined;
      } catch {
        // host input failure — fail-safe deny instead of re-asking forever
        return { decision: 'deny' };
      }
      if (reason === undefined) continue; // cancelled input → back to the options
      return { decision: 'deny', reason };
    }
    // undefined (cancelled) or "Deny" → deny
    return { decision: 'deny' };
  }
}
