// ============================================================
// Plan System — Kimi Code-style Plan Mode
// ============================================================

import type { PlanData, PlanStatus, PlanModeState } from "./types.ts";
import { planModeState, setCurrentPlanMode, setCurrentPlan, setPlanActive } from "./types.ts";
import { registerPlanTools } from "./tools.ts";
import { registerPlanCommands } from "./commands.ts";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Generate a unique plan ID.
 */
function generatePlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ============================================================
// Plan Mode — Kimi Code-style permission model
// ------------------------------------------------------------
// Plan mode does NOT block bash. Bash follows the normal permission
// mode (auto/yolo/manual) — the same as Kimi Code.
// Only the following are blocked during plan mode:
//   - Write/Edit to files OUTSIDE the plan file (plan file is allowed)
//   - TaskStop (would abort running background work during planning)
//   - CronCreate/CronDelete (would mutate scheduled work)
// Everything else passes through to the permission policy chain.
// ============================================================

// ============================================================
// PlanManager — lifecycle + persistence + injection
// ============================================================

export class PlanManager {
  private persistFn: ((data: PlanModeState) => void) | null = null;
  private sessionDir: string = '';
  /** Serialized state of the last appended entry — dedup baseline. */
  private lastPersistedJson: string | null = null;

  /** Bind a persistence callback */
  setPersistence(fn: (data: PlanModeState) => void): void {
    this.persistFn = fn;
  }

  /** Set session directory for plan file storage */
  setSessionDir(dir: string): void {
    this.sessionDir = dir;
  }

  private static safeStringify(value: unknown): string | null {
    try { return JSON.stringify(value); } catch { return null; }
  }

  /**
   * Persist current state.
   * Dedup: skip the append when the serialized state is identical to the
   * last persisted one. Restore validation and repeat lifecycle calls
   * (e.g. exitPlanMode on an already-exited plan) retrigger persist without
   * changing state, which previously appended duplicate muselinn_plan entries.
   */
  private persist(): void {
    if (!this.persistFn) return;
    const json = PlanManager.safeStringify(planModeState);
    if (json !== null && json === this.lastPersistedJson) return;
    if (json !== null) this.lastPersistedJson = json;
    this.persistFn(planModeState);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Generate Kimi Code-style hero slug (e.g., "psylocke-kamala-khan-falcon").
   */
  private generateHeroSlug(): string {
    const adjectives = ['psylocke', 'wolverine', 'cyclops', 'storm', 'jean', 'beast', 'colossus', 'nightcrawler'];
    const nouns = ['kamala-khan', 'peter-parker', 'tony-stark', 'steve-rogers', 'natasha', 'bruce-banner', 'thor', 'loki'];
    const verbs = ['falcon', 'hawk', 'eagle', 'raven', 'wolf', 'fox', 'bear', 'lion'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const verb = verbs[Math.floor(Math.random() * verbs.length)];
    return `${adj}-${noun}-${verb}`;
  }

  /** Ensure plan directory exists (Kimi Code-style) */
  private ensurePlanDirectory(planPath: string): void {
    try {
      const dir = path.dirname(planPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch { /* not critical */ }
  }

  /**
   * Enter Plan Mode (Kimi Code-style).
   * Called by EnterPlanMode tool or /plan command.
   * Creates the plan directory immediately (Kimi Code-style: ensurePlanDirectory).
   */
  enterPlanMode(reason?: string): PlanData {
    const heroSlug = this.generateHeroSlug();
    const planPath = this.sessionDir
      ? path.join(this.sessionDir, "plans", heroSlug) + ".md"
      : path.join("plans", heroSlug) + ".md";
    const plan: PlanData = {
      id: generatePlanId(),
      content: '',
      path: planPath,
      status: 'exploring',
      createdAt: Date.now(),
    };

    this.ensurePlanDirectory(planPath);

    // Write an initial placeholder plan file if none exists yet, so the
    // review panel never hits "plan file not found" for a plan created in
    // this session. Best-effort: a read-only FS must not break plan mode.
    try {
      if (!fs.existsSync(planPath)) {
        fs.writeFileSync(planPath, "# Plan\n\n(Write your plan here.)\n", "utf-8");
      }
    } catch { /* not critical */ }

    setCurrentPlanMode({
      isActive: true,
      currentPlan: plan,
      history: [...planModeState.history, plan],
    });
    this.persist();

    return plan;
  }

  /**
   * Exit Plan Mode (Kimi Code-style).
   * Called by ExitPlanMode tool.
   */
  exitPlanMode(): PlanData | null {
    const plan = planModeState.currentPlan;
    if (!plan) return null;

    // Sync in-memory content from the on-disk plan file (when present and
    // readable) so the review panel and any in-memory consumer see the real
    // plan, not a stale/empty snapshot.
    if (plan.path) {
      try {
        if (fs.existsSync(plan.path)) {
          plan.content = fs.readFileSync(plan.path, "utf-8");
        }
      } catch { /* keep in-memory content on read failure */ }
    }

    plan.status = 'reviewing';
    setCurrentPlan(plan);
    setPlanActive(false);
    this.persist();

    return plan;
  }

  /**
   * Re-enter plan mode to revise the CURRENT plan (Revise path).
   *
   * Unlike enterPlanMode(), this keeps the SAME plan object — same id, same
   * file path, same content — so the user's review context and everything
   * already written survive the round-trip. Falls back to enterPlanMode()
   * only when there is no current plan to revise.
   *
   * @param feedback Optional user feedback from the Revise dialog.
   */
  reenterForRevision(feedback?: string): PlanData {
    const plan = planModeState.currentPlan;
    if (!plan) {
      return this.enterPlanMode("Plan revision requested");
    }

    plan.status = 'writing';
    plan.updatedAt = Date.now();
    if (feedback) {
      plan.revisionFeedback = feedback;
    }
    setCurrentPlan(plan);
    setPlanActive(true);
    this.persist();

    return plan;
  }

  /**
   * Approve the current plan.
   */
  approvePlan(): PlanData | null {
    const plan = planModeState.currentPlan;
    if (!plan) return null;

    plan.status = 'approved';
    plan.approvedAt = Date.now();
    setCurrentPlan(plan);

    // Exit plan mode
    setPlanActive(false);
    this.persist();

    return plan;
  }

  /**
   * Reject the current plan.
   */
  rejectPlan(reason?: string): PlanData | null {
    const plan = planModeState.currentPlan;
    if (!plan) return null;

    plan.status = 'rejected';
    plan.rejectedAt = Date.now();
    plan.rejectionReason = reason;
    setCurrentPlan(plan);

    // Exit plan mode
    setPlanActive(false);
    this.persist();

    return plan;
  }

  /**
   * Clear plan mode (Kimi Code-style /plan clear).
   */
  clearPlan(): void {
    setCurrentPlanMode({
      isActive: false,
      currentPlan: null,
      history: [],
    });
    this.persist();
  }

  /**
   * Clear plan content only (Kimi Code-style /plan clear).
   * Keeps plan mode active, just empties the plan file/content.
   */
  clearPlanContent(): void {
    const plan = planModeState.currentPlan;
    if (!plan) return;
    plan.content = '';
    plan.updatedAt = Date.now();
    setCurrentPlan(plan);
    this.persist();
  }

  /**
   * Set user revision feedback on the current plan.
   * This is used when the user selects Revise and provides
   * textual feedback on what needs to change.
   */
  setRevisionFeedback(feedback: string): void {
    const plan = planModeState.currentPlan;
    if (!plan) return;
    plan.revisionFeedback = feedback;
    plan.updatedAt = Date.now();
    setCurrentPlan(plan);
    this.persist();
  }

  /**
   * Toggle plan mode (Kimi Code-style /plan).
   */
  togglePlanMode(): boolean {
    if (planModeState.isActive) {
      this.exitPlanMode();
      return false;
    } else {
      this.enterPlanMode();
      return true;
    }
  }

  // ── State Queries ──────────────────────────────────────────────────────

  /**
   * Check if plan mode is active.
   */
  isPlanModeActive(): boolean {
    return planModeState.isActive;
  }

  /**
   * Get current plan.
   */
  getCurrentPlan(): PlanData | null {
    return planModeState.currentPlan;
  }

  /**
   * Get plan mode state.
   */
  getState(): PlanModeState {
    return planModeState;
  }

  // ── Plan File Operations ───────────────────────────────────────────────

  /**
   * Update plan content (called when LLM writes to plan file).
   */
  updatePlanContent(content: string, filePath?: string): void {
    const plan = planModeState.currentPlan;
    if (!plan) return;

    plan.content = content;
    if (filePath) plan.path = filePath;
    plan.updatedAt = Date.now();
    setCurrentPlan(plan);
    this.persist();
  }

  /**
   * Get plan file path.
   */
  getPlanFilePath(): string {
    const plan = planModeState.currentPlan;
    if (!plan) return '';
    return plan.path;
  }

  /**
   * True when the given path is the active plan file (or inside the
   * session's plans/ directory). Used for plan-file write approval.
   *
   * Matching rules (shared with shouldBlockTool):
   *   - Exact match on the plan path
   *   - `local://<basename>` scheme (pi core artifact URL, matched by basename)
   *   - Resolved absolute path inside the session's `plans/` directory
   */
  isPlanFilePath(filePath?: string): boolean {
    if (!filePath) return false;

    const plan = planModeState.currentPlan;
    if (plan?.path) {
      // Exact match against the active plan file
      if (filePath === plan.path) return true;
      // local://<name>.md — match basename against the plan filename
      if (filePath.startsWith('local://')) {
        const localBasename = filePath.slice('local://'.length);
        const planBasename = path.basename(plan.path);
        if (localBasename === planBasename) return true;
      }
    }

    // Resolved absolute path inside sessionDir/plans/
    const resolvedFile = path.resolve(filePath);
    const planDir = path.resolve(
      this.sessionDir ? path.join(this.sessionDir, "plans") : path.join("plans")
    );
    return resolvedFile === planDir || resolvedFile.startsWith(planDir + path.sep);
  }

  // ── Tool Restrictions ──────────────────────────────────────────────────

  /**
   * Check if a tool should be blocked in plan mode (Kimi Code-style).
   *
   * Kimi Code's approach:
   * - Bash is NOT blocked — it follows the normal permission mode (auto/yolo/manual).
   * - Write/Edit: blocked unless targeting the active plan file.
   * - Everything else: allowed (passes through to the permission policy chain).
   *
   * The plan file path is matched by:
   *   - Exact match on the filePath parameter (absolute path from the plan session)
   *   - `local://<basename>` scheme (pi core artifact URL, matched by basename)
   *   - Resolved absolute path inside the session's `plans/` directory
   */
  shouldBlockTool(toolName: string, filePath?: string, _command?: string): boolean {
    if (!planModeState.isActive) return false;

    // Write/Edit: only the plan file is writable
    if (toolName === 'write' || toolName === 'edit') {
      if (!filePath) return true; // no path → block
      return !this.isPlanFilePath(filePath);
    }

    // Bash is NOT blocked — follows normal permission mode (auto/yolo/manual),
    // matching Kimi Code's "Bash follows the normal permission mode and rules".
    // Everything else (ask_user_question, read, grep, find, glob,
    // web_search, fetch_content, todo_list, etc.) is allowed.
    return false;
  }

  // ── Context Injection ──────────────────────────────────────────────────

  /** Turn counter for plan mode injection dedup */
  private injectionTurnCount = 0;

  /**
   * Build plan mode injection for system prompt (Kimi Code-style).
   * Full variant on first injection or after user message; sparse variant
   * on subsequent assistant turns to avoid repetition.
   *
   * Wording is aligned with Kimi Code's plan-mode injection
   * (packages/agent-core/src/agent/injection/plan-mode.ts):
   * - Edits are restricted to the current plan file unless a tool request
   *   is explicitly approved.
   * - Bash is NOT banned — it follows the normal permission mode and rules.
   * - TaskStop, CronCreate, CronDelete are blocked in plan mode.
   * - Turns must end with ask_user_question or exit_plan_mode.
   */
  buildInjection(sparse = false): string | undefined {
    if (!planModeState.isActive) return undefined;

    const plan = planModeState.currentPlan;
    const planPath = plan?.path || (this.sessionDir ? `${this.sessionDir}/plans/` : "plans/");

    if (sparse) {
      // Sparse reminder: short, just enough to keep the model oriented
      // (Kimi Code sparseReminder parity).
      return [
        `## Plan Mode Active`,
        ``,
        `Plan mode still active (see full instructions earlier). Prefer read-only tools except the current plan file. Use write or edit to modify the plan file; if it does not exist yet, create it with write first. Use Bash only when needed; Bash follows the normal permission mode and rules. Use ask_user_question to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to exit_plan_mode so the user can choose. End turns with ask_user_question (for clarifications) or exit_plan_mode (for approval). Never ask about plan approval via text or ask_user_question.`,
        ``,
        `Plan file: ${planPath}`,
      ].join('\n');
    }

    // Full reminder (Kimi Code fullReminder parity).
    const parts = [
      `## Plan Mode Active`,
      ``,
      `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received. TaskStop, CronCreate, and CronDelete are also blocked in plan mode — call exit_plan_mode first if you need them.`,
      ``,
      `Workflow:`,
      `  1. Understand — explore the codebase with read, grep, find, ls.`,
      `  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.`,
      `  3. Review — re-read key files to verify understanding.`,
      `  4. Write Plan — modify the plan file with write or edit. Use write if the plan file does not exist yet.`,
      `  5. Exit — call exit_plan_mode for user approval.`,
      ``,
      `## Handling multiple approaches`,
      `Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.`,
      `When the best approach depends on user preferences, constraints, or context you don't have, use ask_user_question to clarify first. This helps you write a better, more targeted plan rather than dumping multiple options for the user to sort through.`,
      `When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling exit_plan_mode, so the user can select which approach to execute at approval time.`,
      `NEVER write multiple approaches in the plan and call exit_plan_mode without the \`options\` parameter — the user will only see the default approval controls with no way to choose a specific approach.`,
      ``,
      `ask_user_question is for clarifying missing requirements or user preferences that affect the plan.`,
      `Never ask about plan approval via text or ask_user_question.`,
      `Your turn must end with either ask_user_question (to clarify requirements or preferences) or exit_plan_mode (to request plan approval). Do NOT end your turn any other way.`,
      ``,
      `Plan file: ${planPath}`,
    ];

    if (plan && plan.content) {
      parts.push(
        ``,
        `Current plan content:`,
        `---`,
        plan.content.slice(0, 500),
        `---`,
      );
    }

    // Inject user's revision feedback when in revision mode
    if (plan && plan.revisionFeedback) {
      parts.push(
        ``,
        `## User Revision Feedback`,
        ``,
        `The user requested the following changes to the plan:`,
        `> ${plan.revisionFeedback}`,
        ``,
        `Please update the plan accordingly.`,
      );
    }

    return parts.join('\n');
  }

  /**
   * Inject plan mode reminder into messages (Kimi Code-style).
   * Uses full injection on the first call or when the last message is
   * from the user; sparse injection on subsequent assistant turns.
   */
  injectIntoMessages(messages: Array<{ role: string; content?: any }>): void {
    if (!planModeState.isActive) return;

    // Detect if this is a consecutive injection (user just replied vs ongoing)
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const isAfterUserInput = lastMsg?.role === 'user' || lastMsg?.role === 'developer';

    // Reset counter on user input; increment otherwise
    if (isAfterUserInput) {
      this.injectionTurnCount = 0;
    } else {
      this.injectionTurnCount++;
    }

    // Use sparse variant after 2+ consecutive assistant turns
    const sparse = this.injectionTurnCount >= 2;
    const injection = this.buildInjection(sparse);
    if (!injection) return;

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        if (Array.isArray(msg.content)) {
          msg.content.push({ type: 'text', text: `\n\n---\n${injection}` });
        } else if (typeof msg.content === 'string') {
          msg.content += `\n\n---\n${injection}`;
        }
        return;
      }
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────

  /**
   * Restore from persisted state.
   */
  restoreFromData(data: PlanModeState): void {
    setCurrentPlanMode(data);
    // The restored state is already persisted — seed the dedup baseline so a
    // subsequent no-change persist doesn't append a duplicate entry.
    this.lastPersistedJson = PlanManager.safeStringify(planModeState);
  }

  /**
   * Validate restored plan state (call right after restoreFromData).
   *
   * A stale persisted entry can claim plan mode is active while holding an
   * empty plan whose file no longer exists on disk — that would silently
   * trap the session in plan mode with nothing to review. In that case we
   * deactivate plan mode (and drop the dead plan) instead.
   *
   * Invalid when: isActive is true but there is no currentPlan, OR the
   * current plan has empty content AND its file does not exist on disk.
   *
   * Returns true when plan mode remains active after validation.
   */
  validateRestoredState(): boolean {
    if (!planModeState.isActive) return false;

    const plan = planModeState.currentPlan;
    let stale = false;
    if (!plan) {
      stale = true;
    } else if (!plan.content) {
      let fileExists = false;
      try {
        fileExists = !!plan.path && fs.existsSync(plan.path);
      } catch { /* treat stat failure as missing */ }
      stale = !fileExists;
    }

    if (stale) {
      setCurrentPlan(null);
      setPlanActive(false);
      this.persist();
      return false;
    }
    return true;
  }

  // ── Format ─────────────────────────────────────────────────────────────

  /**
   * Format plan summary for display.
   */
  formatSummary(): string {
    if (!planModeState.isActive) {
      return 'Plan mode is inactive.';
    }

    const plan = planModeState.currentPlan;
    if (!plan) return 'Plan mode active, no plan.';

    const badge: Record<string, string> = {
      exploring: '🔍 Exploring',
      writing: '📝 Writing',
      reviewing: '👀 Reviewing',
      approved: '✅ Approved',
      rejected: '❌ Rejected',
    };

    const status = badge[plan.status] || plan.status;
    const content = plan.content ? ` (${plan.content.length} chars)` : '';

    return `${status}: ${plan.id}${content}`;
  }

  // ── Registration helpers ───────────────────────────────────────────────

  /** Register plan tools */
  registerTools(pi: any): void {
    registerPlanTools(pi, this);
  }

  /** Register plan commands */
  registerCommands(pi: any): void {
    registerPlanCommands(pi, this);
  }
}

export const planManager = new PlanManager();
