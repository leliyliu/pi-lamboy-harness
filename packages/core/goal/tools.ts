// ============================================================
// Goal Tools — create_goal, get_goal, update_goal
// ============================================================

import type { GoalManager } from "./index.ts";
import type { GoalSnapshot, GoalBudgetLimits } from "./types.ts";
import { parseBudgetToLimits } from "./types.ts";
import { enforceTokenBudgetPolicy } from "./budget.ts";

/** Register goal tools with Pi.
 */
function readCtxEntries(ctx: any): any[] {
  try { return ctx?.sessionManager?.getEntries?.() ?? []; } catch { return []; }
}

export function registerGoalTools(pi: any, goalManager: GoalManager): void {
  // ── create_goal tool ──
  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    promptSnippet: "create_goal / get_goal / update_goal / set_goal_budget: manage the current goal",
    promptGuidelines: [
      "Use create_goal to set a goal before starting complex multi-step work",
      "Use get_goal to check the current goal and its status",
      "Use update_goal to mark the goal status as 'complete', 'paused', or 'active'",
      "When you declare a completion_criterion, the goal can only be completed via update_goal with verified=true",
      "Use set_goal_budget to add or update a budget limit on the active goal",
      "Token budget policy: omit tokenBudget and it defaults to 800000; values under 500000 are raised to the 500000 floor — give generous 500000-800000 budgets sized to the task, never tiny ones; raise via set_goal_budget when work legitimately outgrows the budget",
      "When a goal is active, proactively split work into subagent delegations (explore → scout, review → reviewer, parallel implementation → worker lanes); this session stays the orchestrator — inline only for trivial edits",
      "Keep the model working toward the active goal until it's complete",
    ],
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The goal objective" },
        completion_criterion: {
          type: "string",
          description:
            "How to verify completion. Declaring one adds a hard completion gate: " +
            "update_goal(status='complete') will later be REFUSED unless verified=true is passed.",
        },
        budgetLimits: {
          type: "object",
          description:
            "Budget limits for the goal. Token budget policy: an omitted tokenBudget defaults to 800000; passed values below 500000 are raised to the 500000 floor " +
            "(env PI_LAMBOY_GOAL_TOKEN_BUDGET / PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET, 0 disables each). " +
            "Size token budgets 500000-800000 to the task — never tiny budgets.",
          properties: {
            tokenBudget: {
              type: "number",
              description:
                "Max tokens (input+output). Defaults to 800000 when omitted; floor 500000. " +
                "Give 500000-800000 sized to task scope (large exploration tasks: 800000).",
            },
            turnBudget: { type: "number", description: "Max turns (LLM calls)" },
            wallClockBudgetMs: { type: "number", description: "Max wall clock time in ms" },
          },
        },
        replace: {
          type: "boolean",
          description: "Set to true to overwrite an already-active goal. Defaults to false.",
        },
        autoExtend: {
          type: "boolean",
          description:
            "autoExtend: auto-extend the token budget on exhaustion instead of entering budget_limited. " +
            "Default false: the runtime's auto-renew policy (+800k ahead of exhaustion, max 10, 8M total) " +
            "already keeps the goal running; autoExtend is the legacy +500k crossing-time variant and is not " +
            "needed for normal goals.",
        },
      },
      required: ["objective"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      // P0 (1): active guard surfaces here; createGoal throws when an active
      // goal exists and replace is not explicitly true.
      // Token budget policy (2026-09-29): model-path enforcement — omitted
      // tokenBudget defaults to 800000; values under the 500000 floor are
      // raised. Core createGoal() and user-side /goal stay untouched.
      const policy = enforceTokenBudgetPolicy(params.budgetLimits, { applyDefault: true });
      let g: GoalSnapshot;
      try {
        // Contract: accept BOTH the schema-declared snake_case name
        // (`completion_criterion` — what models actually send) and the legacy
        // camelCase shape (`completionCriterion`). The declared criterion gates
        // completion on verified=true; dropping it would silently bypass that
        // gate (tests/goal.test.mjs §21 locks the passthrough + gate).
        const criterion = params.completion_criterion ?? params.completionCriterion;
        g = goalManager.createGoal(
          params.objective,
          criterion,
          policy.limits,
          "model",
          params.replace === true,
          params.autoExtend === true,
        );
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Cannot create goal: ${err?.message ?? String(err)}` }],
        };
      }
      // Update status bar after creating goal
      if (ctx?.ui?.setStatus && ctx?.ui?.theme) {
        ctx.ui.setStatus("goal", ctx.ui.theme.fg("accent", `[goal ● active · 0s · 0 turns]`));
      }
      let budgetNote = "";
      if (policy.defaulted) {
        budgetNote = `\n[Budget policy] No tokenBudget passed — tokenBudget defaulted to ${policy.appliedTokenBudget} (env PI_LAMBOY_GOAL_TOKEN_BUDGET overrides).`;
      } else if (policy.raised) {
        budgetNote = `\n[Budget policy] tokenBudget raised to the ${policy.appliedTokenBudget} floor — tiny token budgets are against policy (env PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET=0 disables the floor).`;
      }
      return {
        content: [{ type: "text", text: `Goal created: ${g.objective}\nStatus: ${g.status}${budgetNote}\n\n${goalManager.formatGoalPanel(g)}` }],
      };
    },
  });

  // ── get_goal tool ──
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    promptSnippet: "get_goal: check the current goal status",
    promptGuidelines: [
      "Use get_goal to check the current goal and its status",
      "Check goal status before and after completing tasks",
    ],
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
      goalManager.tryRestoreFromEntries(readCtxEntries(ctx));
      const goal = goalManager.getGoal();
      if (!goal) {
        return { content: [{ type: "text", text: "No active goal." }] };
      }
      return { content: [{ type: "text", text: goalManager.formatGoalPanel() }] };
    },
  });

  // ── update_goal tool ──
  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    promptSnippet:
      "update_goal: update the current goal status (complete requires verified=true when a completion_criterion was declared)",
    promptGuidelines: [
      "Use update_goal to mark the goal status as 'complete', 'paused', or 'active'",
      "status='active' resumes from 'paused'/'blocked'/'usage_limited' — use it to self-recover after a provider 429 rate-limit clears; for 'budget_limited' the runtime renews automatically (top-up + resume) when a renewal is still possible",
      "Mark goal as 'complete' only when the objective is achieved and any stated validation has passed — verify the actual state against the objective and every explicit requirement; treat weak or indirect evidence as not complete",
      "If the goal was created with a completion_criterion, status='complete' is REFUSED unless you also pass verified=true in the same call — verified=true is your machine-readable assertion that you checked the criterion against the actual result",
      "Do not mark 'complete' merely because a budget is nearly exhausted or you want to stop",
      "Mark goal as 'blocked' if there's an impasse",
    ],
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "paused", "blocked", "complete"],
          description:
            "New status for the goal. 'active' resumes from paused/blocked/usage_limited — after a provider 429 you are still able to generate responses, which means the window has cleared: call it immediately. Note: 'complete' requires verified=true in the same call when the goal declared a completion_criterion.",
        },
        objective: { type: "string", description: "Updated objective (optional)" },
        reason: { type: "string", description: "Reason for status change (optional)" },
        verified: {
          type: "boolean",
          description:
            "Required=true when marking status='complete' AND the goal has a declared completion_criterion — " +
            "asserts you verified the criterion is actually satisfied. Ignored otherwise.",
        },
      },
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      goalManager.tryRestoreFromEntries(readCtxEntries(ctx));
      const goal = goalManager.getGoal();
      if (!goal) {
        return { content: [{ type: "text", text: "No active goal to update." }] };
      }

      let updated: GoalSnapshot | null = null;

      switch (params.status) {
        case "complete":
          // P0 (2): pass caller's `verified` through; complete() refuses if a
          // criterion is declared but verified is not true.
          updated = goalManager.complete("model", undefined, params.verified === true);
          if (!updated) {
            return {
              content: [{
                type: "text",
                text:
                  "Cannot complete goal: a completionCriterion is declared. " +
                  "Pass verified=true once the criterion has been confirmed satisfied.",
              }],
            };
          }
          break;
        case "paused":
          updated = goalManager.pause("model");
          break;
        case "blocked":
          updated = goalManager.block(params.reason, "model");
          break;
        case "active":
          // Resume from paused/blocked/usage_limited. usage_limited (provider 429)
          // is a temporary external limit — once the rate-limit window clears the
          // model can self-recover. budget_limited (C2, 2026-10-28): the runtime
          // renews + resumes on its own when a renewal is still allowed; when the
          // hard cap already stopped it, autoRecoverBudget returns null and this
          // stays a no-op (the user raises the cap).
          if (goal.status === "paused" || goal.status === "blocked" || goal.status === "usage_limited") {
            updated = goalManager.resume("model");
          } else if (goal.status === "budget_limited") {
            const recovered = goalManager.autoRecoverBudget("model");
            updated = recovered ? goalManager.getGoal() : goal;
          } else {
            updated = goal;
          }
          break;
      }

      if (params.objective && updated) {
        updated = goalManager.editGoal(params.objective, undefined, "model");
      }

      return {
        content: [{ type: "text", text: `Goal updated.\n\n${goalManager.formatGoalPanel()}` }],
      };
    },
  });

  // ── set_goal_budget tool ──
  pi.registerTool({
    name: "set_goal_budget",
    label: "Set Goal Budget",
    promptSnippet: "set_goal_budget: update budget limits for the current goal",
    promptGuidelines: [
      "Use set_goal_budget to add or update a budget limit on the active goal",
      "Units: turns, tokens, ms, s, minutes, hours",
      "Token budgets: values below the 500000 floor are auto-raised to 500000 — raising a budget mid-goal via set_goal_budget to continue work is expected, correct usage (never shrink a goal to fit a tiny budget)",
    ],
    parameters: {
      type: "object",
      properties: {
        budget: {
          type: "number",
          description: "Budget value (token values below the 500000 floor are raised automatically)",
        },
        unit: {
          type: "string",
          enum: ["turns", "tokens", "ms", "s", "minutes", "hours"],
          description: "Budget unit",
        },
      },
      required: ["budget", "unit"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      goalManager.tryRestoreFromEntries(readCtxEntries(ctx));
      const goal = goalManager.getGoal();
      if (!goal) {
        return { content: [{ type: "text", text: "No active goal to set budget on." }] };
      }
      const raw = parseBudgetToLimits(Number(params.budget), String(params.unit));
      // Token budget policy (model path): apply the 500000 floor to passed
      // token values; never inject a default here — setting a turns/ms budget
      // must not silently add a token budget. User-side /goal budget is
      // untouched (commands.ts calls setBudgetLimits directly).
      const policy = enforceTokenBudgetPolicy(raw, { applyDefault: false });
      const updated = goalManager.setBudgetLimits(policy.limits, "model");
      if (!updated) {
        return { content: [{ type: "text", text: "Failed to set goal budget." }] };
      }
      let budgetNote = "";
      if (policy.raised) {
        budgetNote = `\n[Budget policy] tokenBudget raised to the ${policy.appliedTokenBudget} floor — tiny token budgets are against policy (env PI_LAMBOY_GOAL_MIN_TOKEN_BUDGET=0 disables the floor).`;
      }
      return {
        content: [{ type: "text", text: `Goal budget updated.${budgetNote}\n\n${goalManager.formatGoalPanel()}` }],
      };
    },
  });
}
