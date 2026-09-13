// ============================================================
// Handoff Prompt — branch slicing + handoff prompt construction
// (pure, no pi runtime imports; tests load this directly).
//
// getHandoffMessages() is compaction-aware, matching pi's own
// buildContextEntries() semantics (session-format.md:322-342):
//   - no compaction        → whole branch
//   - retainedTail present → compaction summary + materialized
//                            tail + post-compaction entries
//     (newer self-contained checkpoints; BOTH reference
//     implementations miss this variant)
//   - firstKeptEntryId only → summary + kept slice + post entries
//     (legacy format)
// ============================================================

/** Structural view of a session branch entry (session-format.md). */
export interface HandoffBranchEntry {
  id: string;
  type: string;
  /** type === "message": the AgentMessage */
  message?: unknown;
  /** type === "compaction" */
  summary?: string;
  tokensBefore?: number;
  /** legacy compaction: first entry kept after the cut */
  firstKeptEntryId?: string;
  /** newer compaction: materialized AgentMessage[] checkpoint */
  retainedTail?: unknown[];
}

/** AgentMessage-shaped output (message entries pass through as-is). */
export type HandoffMessage =
  | { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number }
  | unknown;

/** Extract the LLM-visible message from a session entry, if any. */
export function entryToMessage(entry: HandoffBranchEntry): HandoffMessage | undefined {
  if (entry.type === "message") {
    return entry.message as HandoffMessage | undefined;
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore ?? 0,
      timestamp: 0,
    };
  }
  return undefined;
}

/**
 * Messages of the current branch, honoring the latest compaction the
 * same way pi rebuilds context for the LLM.
 */
export function getHandoffMessages(branch: HandoffBranchEntry[]): HandoffMessage[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) {
    return branch.map(entryToMessage).filter((m): m is HandoffMessage => m !== undefined);
  }

  const compaction = branch[compactionIndex];

  // Newer self-contained checkpoint: summary + retainedTail + later entries
  if (Array.isArray(compaction.retainedTail)) {
    const out: HandoffMessage[] = [];
    const summary = entryToMessage(compaction);
    if (summary !== undefined) out.push(summary);
    out.push(...(compaction.retainedTail as HandoffMessage[]));
    for (const entry of branch.slice(compactionIndex + 1)) {
      const m = entryToMessage(entry);
      if (m !== undefined) out.push(m);
    }
    return out;
  }

  // Legacy: summary + [firstKeptEntryId, compaction) + post-compaction
  const firstKeptIndex = compaction.firstKeptEntryId
    ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId)
    : -1;
  const slice = [
    compaction,
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
  return slice.map(entryToMessage).filter((m): m is HandoffMessage => m !== undefined);
}

// ---------------------------------------------------------------------------
// Summarization prompt
// ---------------------------------------------------------------------------

/** System prompt for the dedicated handoff-generation LLM call. */
export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new session, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new session should be able to proceed without the old conversation
5. Written in the same language the user and assistant used in the conversation

Format your response as a prompt the user can send to start the new session. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/** User payload for the handoff-generation LLM call. */
export function buildHandoffUserContent(conversationText: string, goal: string): string {
  return `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Session\n\n${goal}`;
}

/**
 * Parent-session footer appended to every handoff prompt. The new session's
 * header records parentSession automatically (ctx.newSession), but the next
 * agent also needs to *know* it can consult the raw transcript.
 *
 * Note: pi 0.85.x has no built-in session_query tool (verified against dist),
 * so we reference the JSONL file path itself — readable with the normal
 * read tool, one JSON entry per line.
 */
export function buildParentFooter(sessionFile: string | undefined, cwd?: string): string {
  if (!sessionFile) return "";
  let display = sessionFile;
  // Sessions live under ~/.pi/agent/sessions/... — keep the absolute path so
  // the next agent can read it regardless of cwd.
  if (cwd && !pathIsAbsolute(sessionFile)) {
    display = joinPath(cwd, sessionFile);
  }
  return (
    `\n\n---\n**Previous session transcript:** \`${display}\`` +
    `(JSONL, one entry per line — read it if you need raw details beyond this brief)` +
    `\nStart from the context above; ask the user only for genuinely new decisions.`
  );
}

// -- tiny path helpers (avoid node:path import so tests stay loader-free) --
function pathIsAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.endsWith(sep) ? base + rel : base + sep + rel;
}
