// ============================================================
// Extension entry: Todo — todo_list tool, /todo command (full
// phase model: init/start/done/drop/rm/append/export/import/
// copy/edit/toggle), inline panel widget, completion auto-fade,
// stop-time reminders, and session persistence.
//
// Filter out this file to drop the todo panel + tool.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerTodoList,
  registerTodoReminders,
  bindTodoSession,
  clearTodoSession,
  restoreTodos,
  rt,
  persist,
  refreshWidget,
  togglePanel,
  syncTodoAutoClearTimer,
} from "../todo/index";
import { phasesToMarkdown, markdownToPhases, applyOp, TodoPhase, TodoItem } from "../packages/core/todo/types";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Restore the todo panel (before binding so the first refresh shows it)
    try {
      restoreTodos(ctx.sessionManager.getEntries());
      syncTodoAutoClearTimer();
    } catch { /* ok */ }
    try {
      bindTodoSession(ctx, (type, data) => { try { pi.appendEntry(type, data); } catch { /* stale ctx */ } });
    } catch { /* ok */ }
    try {
      refreshWidget();
    } catch { /* ok */ }
  });

  pi.on("session_shutdown", () => {
    try { clearTodoSession(); } catch { /* stale ctx */ }
  });

  // ── Register todo tool + reminders ──
  registerTodoList(pi);
  registerTodoReminders(pi);

  // ── Register /todo slash command ──
  registerTodoCommand(pi);
}

// ── /todo slash command ────────────────────────────────────────

/**
 * Register the /todo user slash command for manual todo management.
 * Call after registerTodoList.
 */
function registerTodoCommand(pi: any): void {
  pi.registerCommand("todo", {
    description: "Manage todo list (append / start / done / drop / rm / import / export / copy / edit)",
    usage: [
      "/todo                              Show todos as Markdown",
      "/todo import [<path>]              Replace todos from file (default: TODO.md)",
      "/todo export [<path>]              Export todos to file (default: TODO.md)",
      "/todo copy                         Print todos as Markdown to conversation",
      "/todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
      "/todo start  <task>                Mark task in_progress (fuzzy match)",
      "/todo done   [<task|phase>]        Mark task/phase/all completed",
      "/todo drop   [<task|phase>]        Mark task/phase/all abandoned",
      "/todo rm     [<task|phase>]        Remove task/phase/all",
      "/todo edit                         Hint: use export then import",
      "/todo toggle                       Expand/collapse the todo panel",
    ].join("\n"),
    getArgumentCompletions: (prefix: string) => {
      const subcmds = [
        { value: "import", label: "/todo import", description: "Replace todos from file" },
        { value: "export", label: "/todo export", description: "Export todos to file" },
        { value: "copy",   label: "/todo copy",   description: "Print todos as Markdown to conversation" },
        { value: "append", label: "/todo append", description: "Append a task" },
        { value: "start", label: "/todo start", description: "Mark task in_progress" },
        { value: "done",   label: "/todo done",   description: "Mark task/phase/all completed" },
        { value: "drop",   label: "/todo drop",   description: "Mark task/phase/all abandoned" },
        { value: "rm",     label: "/todo rm",     description: "Remove task/phase/all" },
        { value: "edit",   label: "/todo edit",   description: "Open in editor" },
        { value: "toggle", label: "/todo toggle", description: "Expand/collapse the todo panel" },
      ];
      if (!prefix) return subcmds;
      const lower = prefix.toLowerCase();
      return subcmds.filter(s => s.value.startsWith(lower));
    },
    handler: async (args: string, ctx: any) => {
      rt.ctx = ctx;
      const trimmed = (args || "").trim();
      const spaceIdx = trimmed.indexOf(" ");
      const subcmd = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
      const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

      switch (subcmd) {
        case "import": {
          const { readFileSync, existsSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          const cwd = ctx?.cwd || process.cwd();
          let filePath = rest || "TODO.md";
          if (!existsSync(filePath)) filePath = resolve(cwd, filePath);
          if (!existsSync(filePath)) {
            ctx?.showStatus?.(`File not found: ${filePath}`);
            return;
          }
          const md = readFileSync(filePath, "utf-8");
          const { phases, errors } = markdownToPhases(md);
          if (errors.length > 0) {
            ctx?.showStatus?.(`Import errors: ${errors.join("; ")}`);
          }
          if (phases.length === 0) {
            ctx?.showStatus?.("No tasks found in file.");
            return;
          }
          rt.phases = phases;
          persist();
          refreshWidget();
          const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
          ctx?.showStatus?.(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${filePath}.`);
          return;
        }

        case "append": {
          if (!rest) { ctx?.showStatus?.("Usage: /todo append [<phase>] <task...>"); return; }
          const tokens = parseTokens(rest);
          // First token might be a phase name (fuzzy match), rest is the task
          const phases = rt.phases;
          const { phases: next, errors } = applyOp(phases, { op: "append", phase: tokens.length > 1 ? tokens[0] : "Tasks", items: [tokens.length > 1 ? tokens.slice(1).join(" ") : tokens[0]] });
          if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
          rt.phases = next;
          persist();
          refreshWidget();
          ctx?.showStatus?.(`Appended: ${tokens[tokens.length - 1]}`);
          return;
        }

        case "start": {
          if (!rest) { ctx?.showStatus?.("Usage: /todo start <task>"); return; }
          const found = findTaskFuzzy(rt.phases, rest);
          if (!found) { ctx?.showStatus?.(`Task not found: ${rest}`); return; }
          const { phases: next, errors } = applyOp(rt.phases, { op: "start", task: found.task.content });
          if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
          rt.phases = next;
          persist();
          refreshWidget();
          ctx?.showStatus?.(`Started: ${found.task.content}`);
          return;
        }

        case "done": {
          if (!rest) {
            // No args → mark all done
            const { phases: next, errors } = applyOp(rt.phases, { op: "done" });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.("All tasks completed.");
            return;
          }
          // Try task first, then phase
          const taskMatch = findTaskFuzzy(rt.phases, rest);
          if (taskMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "done", task: taskMatch.task.content });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Completed: ${taskMatch.task.content}`);
            return;
          }
          const phaseMatch = findPhaseFuzzy(rt.phases, rest);
          if (phaseMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "done", phase: phaseMatch.name });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Phase completed: ${phaseMatch.name}`);
            return;
          }
          ctx?.showStatus?.(`Task/phase not found: ${rest}`);
          return;
        }

        case "drop": {
          if (!rest) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "drop" });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.("All tasks abandoned.");
            return;
          }
          const taskMatch = findTaskFuzzy(rt.phases, rest);
          if (taskMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "drop", task: taskMatch.task.content });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Dropped: ${taskMatch.task.content}`);
            return;
          }
          const phaseMatch = findPhaseFuzzy(rt.phases, rest);
          if (phaseMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "drop", phase: phaseMatch.name });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Phase abandoned: ${phaseMatch.name}`);
            return;
          }
          ctx?.showStatus?.(`Task/phase not found: ${rest}`);
          return;
        }

        case "rm": {
          if (!rest) {
            rt.phases = [];
            persist();
            refreshWidget();
            ctx?.showStatus?.("Cleared all todos.");
            return;
          }
          const taskMatch = findTaskFuzzy(rt.phases, rest);
          if (taskMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "rm", task: taskMatch.task.content });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Removed: ${taskMatch.task.content}`);
            return;
          }
          const phaseMatch = findPhaseFuzzy(rt.phases, rest);
          if (phaseMatch) {
            const { phases: next, errors } = applyOp(rt.phases, { op: "rm", phase: phaseMatch.name });
            if (errors.length > 0) { ctx?.showStatus?.(`Error: ${errors.join("; ")}`); return; }
            rt.phases = next;
            persist();
            refreshWidget();
            ctx?.showStatus?.(`Phase removed: ${phaseMatch.name}`);
            return;
          }
          ctx?.showStatus?.(`Task/phase not found: ${rest}`);
          return;
        }

        case "export": {
          const { writeFileSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          const cwd = ctx?.cwd || process.cwd();
          const filePath = rest || "TODO.md";
          if (rt.phases.length === 0) { ctx?.showStatus?.("No todos to export."); return; }
          const md = phasesToMarkdown(rt.phases);
          try {
            writeFileSync(resolve(cwd, filePath), md, "utf-8");
            ctx?.showStatus?.(`Exported ${rt.phases.length} phase(s) to ${filePath}`);
          } catch (e: any) {
            ctx?.showStatus?.(`Export failed: ${e?.message || e}`);
          }
          return;
        }

        case "copy": {
          if (rt.phases.length === 0) { ctx?.showStatus?.("No todos."); return; }
          const md = phasesToMarkdown(rt.phases);
          ctx?.showStatus?.(md);
          return;
        }

        case "edit": {
          ctx?.showStatus?.("/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.");
          return;
        }
        case "toggle": {
          togglePanel();
          return;
        }
        default: {
          if (rt.phases.length === 0) { ctx?.showStatus?.("No todos. Use /todo append <task> to start one."); return; }
          const md = phasesToMarkdown(rt.phases);
          ctx?.showStatus?.(md, { wrap: true });
          return;
        }
      }
    },
  });
}

// ── Fuzzy helpers for /todo command ────────────────────────────

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  // Exact name (case-insensitive)
  const exact = phases.find((p) => p.name.toLowerCase() === q);
  if (exact) return exact;
  // Prefix match
  return phases.find((p) => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(q));
}

function findTaskFuzzy(phases: TodoPhase[], query: string): { task: TodoItem; phase: TodoPhase } | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  // Exact content (case-insensitive)
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content.toLowerCase() === q);
    if (task) return { task, phase };
  }
  // Substring match
  const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase().includes(q)) {
        matches.push({ task, phase });
      }
    }
  }
  return matches[0];
}

/** Parse quoted tokens from a command string (e.g. /todo append "My Phase" task) */
function parseTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === " " && !inQuote) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}
