// ============================================================
// Handoff command (adapter, pi extension).
//
// /handoff <goal> — transfer context to a new focused session.
//
// Flow (execution path follows the official upstream handoff
// example — the deprecated ogulcancelik/pi-handoff package failed
// precisely because its tool tried to start sessions directly;
// ExtensionContext has no newSession, types.d.ts:372 vs :248):
//   1. If a fresh agent-authored draft exists (handoff tool) → use it,
//      skip the model call.
//   2. Otherwise: flatten the branch (compaction-aware) → one dedicated
//      modelRegistry.complete call generates the handoff prompt
//      (BorderedLoader, abortable).
//   3. User reviews/edits the prompt in the editor.
//   4. ctx.newSession({ parentSession }) — new session records the
//      parent, editor prefilled with the prompt; user submits when
//      ready.
// ============================================================

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
  buildHandoffUserContent,
  buildParentFooter,
  getHandoffMessages,
  HANDOFF_SYSTEM_PROMPT,
  type HandoffBranchEntry,
} from "../packages/core/handoff/prompt.ts";
import { latestHandoffDraft } from "../packages/core/handoff/guard.ts";
import { goalManager } from "../packages/core/goal/index.ts";

export function registerHandoffCommands(pi: ExtensionAPI): void {
  // ── /handoff [goal] — transfer context to a new focused session ──
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (review & edit before switching)",
    handler: async (args, ctx) => {
      try {
        await runHandoffFlow(ctx, args.trim());
      } catch (err) {
        try {
          ctx.ui.notify(`handoff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        } catch { /* never leave the UI stuck */ }
      }
    },
  });
}

async function runHandoffFlow(ctx: ExtensionCommandContext, goal: string): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("handoff requires interactive mode", "error");
    return;
  }

  const branch = ctx.sessionManager.getBranch() as unknown as HandoffBranchEntry[];

  // Agent-authored draft from the handoff tool: reuse it (the agent had
  // full context; regenerating would waste a call). Only when fresh and
  // the user didn't bring a new goal of their own.
  const draft = latestHandoffDraft(branch);
  if (!goal && draft?.fresh) {
    await reviewAndSwitch(ctx, draft.prompt);
    return;
  }

  if (!goal) {
    ctx.ui.notify("Usage: /handoff <goal for the new session>", "error");
    return;
  }
  if (!ctx.model) {
    ctx.ui.notify("No model selected", "error");
    return;
  }

  const messages = getHandoffMessages(branch);
  if (messages.length === 0) {
    ctx.ui.notify("No conversation to hand off", "error");
    return;
  }

  const conversationText = serializeConversation(convertToLlm(messages as never[]));
  const generated = await generateHandoffPrompt(ctx, conversationText, goal);
  if (generated === null) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }
  await reviewAndSwitch(ctx, generated);
}

/** One dedicated LLM call that writes the handoff prompt. Abortable. */
async function generateHandoffPrompt(
  ctx: ExtensionCommandContext,
  conversationText: string,
  goal: string,
): Promise<string | null> {
  const model = ctx.model!;

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
    loader.onAbort = () => done(null);

    (async () => {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: HANDOFF_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: buildHandoffUserContent(conversationText, goal) },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        { signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() },
      );

      if (response.stopReason === "aborted") return null;

      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    })()
      .then(done)
      .catch((err) => {
        console.error("Handoff generation failed:", err);
        done(null);
      });

    return loader;
  });
}

/** Editor review → new session with parent link + prefilled prompt. */
async function reviewAndSwitch(ctx: ExtensionCommandContext, promptText: string): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const finalPrompt = promptText + buildParentFooter(sessionFile, ctx.cwd);

  const edited = await ctx.ui.editor("Review handoff prompt (submit as the new session's opening prompt)", finalPrompt);
  if (edited === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  let renewal: { renewed: boolean; newBudget?: number; resumed: boolean } | undefined;

  const result = await ctx.newSession({
    parentSession: sessionFile,
    // 2026-10-26: a handoff creates a NEW session, but the goal lives in this
    // process-level singleton — without this hook the new session inherits an
    // exhausted budget_limited goal and every tool stays gated ("handoff did
    // not extend the budget"). `setup` runs after session_start and before
    // withSession, and receives the writable new-session SessionManager
    // (docs/extensions.md: ctx.newSession options), so the extended goal is
    // persisted into the NEW session. The old pi.appendEntry is invalidated
    // after session replacement (it throws and 40-goal's try/catch swallows
    // it), so writing through `sm` is the only reliable path.
    // Wrapped: a renewal failure must never abort the already-switched
    // handoff (it would drop the user's edited briefing).
    setup: async (sm) => {
      try {
        renewal = goalManager.renewForHandoff((type, data) => sm.appendCustomEntry(type, data));
      } catch { /* never break handoff */ }
    },
    withSession: async (replacementCtx) => {
      // Only the replacement-session ctx is valid here (docs: session
      // replacement lifecycle) — never the captured old one.
      replacementCtx.ui.setEditorText(edited);
      if (renewal?.renewed) {
        replacementCtx.ui.notify(
          `Goal budget extended to ${renewal.newBudget} for this session${renewal.resumed ? " (goal resumed)" : ""}.`,
          "info",
        );
      } else {
        replacementCtx.ui.notify("Handoff ready — submit when ready.", "info");
      }
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("New session cancelled", "info");
  }
}
