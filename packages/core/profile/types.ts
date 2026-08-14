// ============================================================
// Profile Types — sub-agent profile definitions
//
// Each profile declares what tools it may use and carries a
// roleAdditional prompt that governs the agent's behavior.
// ============================================================

/** Tool names understood by the tool builder. */
export type ProfileToolName =
  | "bash"
  | "read"
  | "edit"
  | "write"
  | "grep"
  | "find"
  | "ls"
  | "webSearch"
  | "fetchURL"
  | "sourceCheck"
  | "getSearchContent"
  | "readMediaFile"
  | "agent"
  | "agentSwarm"
  | "taskList"
  | "taskOutput"
  | "taskStop"
  | "cronCreate"
  | "cronDelete"
  | "cronList"
  | "todoList"
  | "enterPlanMode"
  | "exitPlanMode"
  | "createGoal"
  | "getGoal"
  | "updateGoal"
  | "setGoalBudget"
  | "askUserQuestion"
  | "skill"
  | "mcp__*";

/** A sub-agent profile (mirrors YAML structure). */
export interface SubAgentProfile {
  /** Profile name — must match the subagent_type value. */
  name: string;
  /** Human-readable description for the caller. */
  description: string;
  /** When-to-use guidance shown in the agent tool descriptor. */
  whenToUse: string;
  /** Additional role prompt injected into the sub-agent's system prompt. */
  roleAdditional: string;
  /** Tool allowlist for this profile. */
  tools: ProfileToolName[];
}
