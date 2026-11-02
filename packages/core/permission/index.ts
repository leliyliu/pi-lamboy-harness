// ============================================================
// Permission Manager — policy chain executor
// ============================================================

import type { PermissionMode, PolicyContext, PolicyResult } from './types.ts';
import { setMode, sessionApprovals } from './types.ts';
import { policyChain, isDestructive, inputFingerprint } from './policies.ts';
import { loadAgentsMd, loadDefaultMode } from './config.ts';
import { approvalTimeoutFor, formatDuration, loadApprovalTimeoutConfig, runDialogWithTimeout } from './timeout.ts';
import { emitAttention } from '../attention/index.ts';
import { resolveWorkspaceLabel } from '../workspace/index.ts';

/** Adapter-injected approval dialog outcome. */
export interface ApprovalDialogResult {
  decision: 'once' | 'always' | 'deny';
  /** Optional user-supplied reason attached to a deny (relayed to the model). */
  reason?: string;
  /**
   * The idle timeout closed the dialog (nobody answered). Callers must treat
   * it as an allow-once that is NEVER written to session history.
   */
  timedOut?: boolean;
}

/** Idle-timeout context handed to the dialog adapter. */
export interface ApprovalDialogOptions {
  /** Auto-allow window in ms; undefined = block until the user answers. */
  timeoutMs?: number;
  /** True when the ask came from a destructive-operation guard. */
  isDestructive?: boolean;
  /**
   * Workspace the call belongs to (see packages/core/workspace). Rendered by
   * the dialog so a user with several Paseo workspaces can tell which agent
   * is blocked without switching panes.
   */
  workspace?: string;
  /** The cwd the approval is about (shown next to the label). */
  cwd?: string;
}
/** RPC/limited-UI approval dialog fallback (select/confirm/input). */
export { approvalViaRpcUi, type ApprovalDialogCtx } from './approval-rpc.ts';
/** Adapter-injected approval dialog: three-way ask outcome. */
export type ApprovalDialogFn = (
  ctx: any,
  toolName: string,
  title: string,
  message: string,
  opts?: ApprovalDialogOptions,
) => Promise<ApprovalDialogResult>;

/** One auto-approved-by-timeout record, relayed to the model once. */
export interface TimeoutNotice {
  at: number;
  toolName: string;
  policyName: string;
  message?: string;
  timeoutMs: number;
  destructive: boolean;
  /** What exactly ran (bash command / input excerpt) — the model must know. */
  detail?: string;
  /** Workspace label at the time of the call (packages/core/workspace). */
  workspace?: string;
}

export class PermissionManager {
  private mode: PermissionMode = loadDefaultMode();
  private lastMode: PermissionMode | undefined;
  private persistFn: ((mode: PermissionMode) => void) | null = null;
  private approvalDialog: ApprovalDialogFn | null = null;
  /** Auto-approvals produced by the idle timeout, pending model-facing relay. */
  private pendingTimeouts: TimeoutNotice[] = [];

  /** Bind a persistence callback */
  setPersistence(fn: (mode: PermissionMode) => void): void {
    this.persistFn = fn;
  }

  /**
   * Inject the interactive approval dialog (adapter). When unset, asks fall
   * back to ctx.ui.confirm with the original semantics (approve = record).
   * 'once' approves without recording; 'always' approves and records for the
   * session; 'deny' blocks.
   */
  setApprovalDialog(fn: ApprovalDialogFn | null): void {
    this.approvalDialog = fn;
  }

  /** Get current permission mode */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** Set permission mode */
  setMode(mode: PermissionMode): void {
    this.lastMode = this.mode !== mode ? this.mode : undefined;
    this.mode = mode;
    setMode(mode);
    if (this.persistFn) this.persistFn(mode);
  }

  /**
   * Evaluate tool call through the policy chain.
   * Returns { block: true, reason } to block, or undefined to allow.
   */
  async evaluate(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
    ctx: any
  ): Promise<{ block: true; reason: string } | undefined> {
    const sessionId: string =
      (ctx?.sessionManager?.getSessionId?.() as string) ||
      (ctx?.sessionId as string) ||
      'default';
    const policyCtx: PolicyContext = {
      toolName,
      input,
      cwd,
      mode: this.mode,
      hasUI: ctx?.hasUI ?? true,
      signal: ctx?.signal,
      sessionId,
      agentsMd: loadAgentsMd(cwd),
    };

    // Set when an ask was allowed by the idle timeout: allow ONCE (neither the
    // later `approve` policies nor the "all policies passed" step may memoize it).
    let timedOutAllow: TimeoutNotice | null = null;

    for (const policy of policyChain) {
      try {
        const result = await policy.evaluate(policyCtx);
        if (result === null) continue;

        if (result.kind === 'deny') {
          return { block: true, reason: result.reason || `Blocked by ${policy.name}` };
        }

        if (result.kind === 'approve') {
          // A later approve policy (yolo / auto / user-allow / default) fires
          // right after a timeout `continue` — it must NOT write session
          // memory, or the "allow once" promise silently degrades into
          // "never asks again".
          if (timedOutAllow) {
            this.announceTimeout(timedOutAllow, ctx);
            return undefined;
          }
          // Record approval in session history (by input fingerprint).
          // Destructive actions never short-circuit history, so don't record them.
          this.recordApproval(policyCtx);
          return undefined;  // Allow
        }

        if (result.kind === 'ask') {
          if (!policyCtx.hasUI) {
            return {
              block: true,
              reason:
                `BLOCKED — tool "${toolName}" was NOT executed: this session is non-interactive (no UI), ` +
                `so the required approval (${policy.name}) could not be presented. ` +
                `Do not treat the action as completed. Ask the user to run interactively or switch permission mode (auto/yolo).`,
            };
          }

          // The user is about to be asked to approve this call: surface it
          // outside the terminal (no-op unless a notifier extension registered
          // one; non-TUI hosts are gated by mode inside emitAttention).
          // The workspace label is what tells several concurrent Paseo
          // workspaces apart in the popup.
          const workspace = resolveWorkspaceLabel(policyCtx.cwd);
          emitAttention({
            kind: 'approval',
            title: '🔐 需要授权',
            body: `${toolName}: ${result.message || policy.name}`,
            workspace,
            mode: (ctx as any)?.mode,
          });

          // The model must be able to tell WHAT was auto-approved, not just
          // which tool (computed lazily: the ask path is the only consumer).
          let actionDetail = '';
          try {
            actionDetail = typeof input.command === 'string'
              ? input.command.slice(0, 200)
              : JSON.stringify(input).slice(0, 200);
          } catch { /* unserialisable input — omit the detail */ }

          if (this.approvalDialog) {
            const destructive = isDestructive(policyCtx);
            const timeoutMs = approvalTimeoutFor(
              destructive ? 'approval-destructive' : 'approval',
              policyCtx.mode,
              loadApprovalTimeoutConfig(policyCtx.cwd),
            );
            const outcome = await this.approvalDialog(
              ctx, toolName, 'Approval Required', result.message || `Tool: ${toolName}`,
              { timeoutMs, isDestructive: destructive, workspace, cwd: policyCtx.cwd },
            );
            if (outcome.timedOut) {
              // Nobody answered: allow once, remember nothing. The chain keeps
              // running so any later deny policy still wins; the notification
              // waits until the call is actually allowed.
              timedOutAllow = {
                at: Date.now(),
                toolName,
                policyName: policy.name,
                message: result.message,
                timeoutMs: timeoutMs ?? 0,
                destructive,
                detail: actionDetail,
                workspace,
              };
              continue;
            }
            if (outcome.decision === 'deny') {
              const why = outcome.reason ? ` — user reason: ${outcome.reason}` : '';
              return { block: true, reason: `User denied: ${policy.name}${why}` };
            }
            // 'always' records for the session; 'once' approves just this call.
            if (outcome.decision === 'always') this.recordApproval(policyCtx);
            continue;
          }

          // No adapter injected: confirm() fallback, same idle-timeout contract.
          const destructiveFallback = isDestructive(policyCtx);
          const fallbackTimeoutMs = approvalTimeoutFor(
            destructiveFallback ? 'approval-destructive' : 'approval',
            policyCtx.mode,
            loadApprovalTimeoutConfig(policyCtx.cwd),
          );
          const confirmed = await runDialogWithTimeout(
            (dialogOpts) => ctx.ui.confirm(
              'Approval Required',
              result.message || `Tool: ${toolName}\n\nAllow?`,
              { signal: dialogOpts.signal },
            ),
            fallbackTimeoutMs,
            // A session abort must still dismiss the dialog (and is NOT a timeout).
            ctx?.signal,
          );
          // confirm() resolves false on abort (pi: `result === "Yes"`), so a
          // timeout shows up as `aborted && false`, never as `undefined`.
          if (confirmed.aborted && confirmed.value !== true) {
            timedOutAllow = {
              at: Date.now(),
              toolName,
              policyName: policy.name,
              message: result.message,
              timeoutMs: fallbackTimeoutMs ?? 0,
              destructive: destructiveFallback,
              detail: actionDetail,
              workspace,
            };
            continue;
          }
          if (!confirmed.value) {
            return { block: true, reason: `User denied: ${policy.name}` };
          }
          // Record approval and continue to next policy
          this.recordApproval(policyCtx);
        }
      } catch {
        // Policy error: fail-safe by continuing to next policy
        continue;
      }
    }

    // All policies passed (no deny, all asks approved)
    // A timeout approval is allow-once: skip the session-memory write.
    if (timedOutAllow) {
      this.announceTimeout(timedOutAllow, ctx);
      return undefined;
    }
    this.recordApproval(policyCtx);
    return undefined;
  }

  /**
   * Surface an idle-timeout auto-approval: notify outside the terminal, tell
   * the user in-app, and queue a one-shot note for the model.
   */
  private announceTimeout(notice: TimeoutNotice, ctx: any): void {
    const last = this.pendingTimeouts[this.pendingTimeouts.length - 1];
    const duplicate = last
      && last.toolName === notice.toolName
      && last.policyName === notice.policyName
      && notice.at - last.at < 5000;
    if (!duplicate) this.pendingTimeouts.push(notice);

    try {
      emitAttention({
        kind: 'approval',
        title: notice.destructive ? '⏰ 破坏性操作超时放行' : '⏰ 授权超时放行',
        body: `${notice.toolName}: ${notice.message || notice.policyName}（${formatDuration(notice.timeoutMs)} 无操作）`,
        workspace: notice.workspace,
        mode: ctx?.mode,
      });
    } catch { /* fail-open: notification must never block the chain */ }

    try {
      ctx?.ui?.notify?.(
        `⏰ ${formatDuration(notice.timeoutMs)} 无操作 — 已自动放行 ${notice.toolName}（仅本次，未记入会话）`,
        'warning',
      );
    } catch { /* notify is best-effort */ }
  }

  /** Drain pending timeout notes (consumed once when injected into messages). */
  drainTimeoutNotices(): TimeoutNotice[] {
    if (this.pendingTimeouts.length === 0) return [];
    const drained = this.pendingTimeouts;
    this.pendingTimeouts = [];
    return drained;
  }

  /** Model-facing block describing idle-timeout auto-approvals. */
  private buildTimeoutNotice(notices: TimeoutNotice[]): string | undefined {
    if (notices.length === 0) return undefined;
    const lines = notices.map((n) => {
      const flag = n.destructive ? '⚠️ DESTRUCTIVE' : '·';
      const detail = (n.detail || n.message || n.policyName).split('\n')[0]!.slice(0, 200);
      return `- ${flag} ${n.toolName}: ${detail} — ${formatDuration(n.timeoutMs)} idle (${n.policyName})`;
    });
    return `## ⏰ Idle-timeout auto-approval (not reviewed by the user)

The user was away. The following calls were approved by the idle timeout as ALLOW-ONCE (never added to session approvals):
${lines.join('\n')}

  - Re-check the result of each call. If it was irreversible or contradicts the user's intent, stop and report it instead of continuing.
  - Do not repeat destructive actions just because one was auto-approved.`;
  }

  /** Record tool approval in session history (keyed by input fingerprint, not toolName alone) */
  private recordApproval(policyCtx: PolicyContext): void {
    // Destructive commands are one-shot — never cached for replay.
    if (isDestructive(policyCtx)) return;

    const sessionId = policyCtx.sessionId || 'default';
    if (!sessionApprovals.has(sessionId)) {
      sessionApprovals.set(sessionId, new Set());
    }
    sessionApprovals
      .get(sessionId)!
      .add(inputFingerprint(policyCtx.toolName, policyCtx.input));
  }

  /** Reset session approval history */
  resetHistory(): void {
    sessionApprovals.clear();
  }

  /** Format mode for status bar */
  formatMode(): string {
    return this.mode;
  }

  /** Build model-facing injection text for permission mode context */
  buildInjection(): string | undefined {
    const currentMode = this.mode;
    const previousMode = this.lastMode;

    if (currentMode === previousMode) {
      // No mode change: only inject if auto mode (keep reminding)
      if (currentMode !== 'auto') return undefined;
      return `## Permission Mode: Auto

Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.
  - Continue normally without pausing for approval prompts.
  - Do NOT call AskUserQuestion while auto mode is active. Make a reasonable decision and continue without asking the user.
  - ExitPlanMode is also approved automatically, without the user reviewing the plan. An auto-approved plan is NOT a signal from the user to start executing — follow the user's original instructions on whether to proceed.`;
    }

    this.lastMode = currentMode;

    if (currentMode === 'auto') {
      return `## Permission Mode: Auto

Auto permission mode is now active. Tool approvals will be handled automatically.
  - Do NOT call AskUserQuestion while auto mode is active. Make a reasonable decision and continue without asking the user.
  - ExitPlanMode is also approved automatically, without the user reviewing the plan. An auto-approved plan is NOT a signal from the user to start executing — follow the user's original instructions on whether to proceed.`;
    }

    if (previousMode === 'auto') {
      return `## Permission Mode: ${currentMode.toUpperCase()}

Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode.
  - Continue normally, but expect approval prompts or denials when a tool requires them.`;
    }

    switch (currentMode) {
      case 'yolo':
        return `## Permission Mode: YOLO

YOLO permission mode is active. Actions are unconditionally allowed, but destructive operations, sensitive file access, and .git control paths still require approval.
  - You CAN call AskUserQuestion for clarifications — it is NOT disabled in YOLO mode.
  - Safety checks (destructive commands, sensitive files, git control paths) still run before auto-approval.
  - ExitPlanMode still shows the plan review panel — the user needs to approve the plan before execution.
  - This is "trust but verify": fast execution with guards for dangerous operations.`;
      default:
        return undefined;
    }
  }

  /**
   * Inject permission mode reminder into messages (called from context event).
   *
   * Cache-friendly (docs/research/client-injection-cache-optimization.md):
   * the reminder lands as a TAIL user message, never in the system prompt —
   * system appends invalidate the prefix cache for the whole conversation.
   * The message is ephemeral (context-event deep copy), so it is not
   * persisted into the session.
   */
  injectIntoMessages(messages: Array<{ role: string; content?: any; timestamp?: number }>): void {
    const injection = this.buildInjection();
    const timeoutNotice = this.buildTimeoutNotice(this.drainTimeoutNotices());
    const parts = [injection, timeoutNotice].filter((p): p is string => Boolean(p));
    if (parts.length === 0) return;
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: parts.join('\n\n') }],
      timestamp: Date.now(),
    });
  }
}

export const permissionManager = new PermissionManager();
