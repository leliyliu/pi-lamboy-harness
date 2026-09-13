// ============================================================
// Extension entry: Sanitize — normalize malformed toolCall
// arguments so they never reach the provider as-is.
//
// Incident (2026-09-13, jdcloud/GLM-5.3, plans/2026-09-13-glm53-
// jdcloud-1210-error-analysis.md): the model occasionally emitted a
// toolCall whose `arguments` was a top-level JSON array. pi refused
// execution locally but kept the malformed structure in session
// history, and every later request failed with 400 / code 1210,
// dead-locking the session.
//
// Three defensive layers (all no-ops on clean traffic, all
// exception-guarded so a bug here can never break a request):
//   message_end          — fix the message the moment it finalizes,
//                          so the session file stays clean AND the
//                          tool executes the repaired args directly
//   context              — fix every outgoing LLM call, which also
//                          rescues sessions poisoned before install
//   before_provider_request — wire-format last resort
//
// Plus /sanitize-session to repair a historical session file
// (backup .bak-sanitize, atomic rewrite, per-tool fix report).
//
// Filter out this file to disable the guard.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeMessages, sanitizeProviderPayload, sanitizeSessionLines } from "../packages/core/sanitize/index.ts";

/** Fixes applied at message_end this session (for the command report). */
let liveFixes = 0;

function notifyFixes(ctx: any, fixes: { toolName: string; kind: string }[]): void {
  try {
    if (!fixes.length || !ctx?.ui?.notify) return;
    const names = [...new Set(fixes.map((f) => f.toolName))].join(", ");
    const kinds = [...new Set(fixes.map((f) => f.kind))].join("/");
    ctx.ui.notify(`[sanitize] 已修复 ${fixes.length} 个畸形工具参数（${kinds} → 对象，涉及 ${names}）`, "info");
  } catch { /* never interrupt */ }
}

export default function (pi: ExtensionAPI) {
  // ── L1: message_end — repair at finalization (persist + execute clean) ──
  pi.on("message_end", (event: any, ctx: any) => {
    try {
      const msg = event?.message;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
      const { messages, fixes } = sanitizeMessages([msg]);
      if (fixes.length === 0) return undefined;
      liveFixes += fixes.length;
      notifyFixes(ctx, fixes);
      return { message: messages[0] };
    } catch { return undefined; }
  });

  // ── L2: context — repair every outgoing LLM call (silent: may re-fix the
  // same history every turn, so no notify here; message_end owns reporting) ──
  pi.on("context", (event: any, _ctx: any) => {
    try {
      const { messages, fixes } = sanitizeMessages(event?.messages ?? []);
      if (fixes.length === 0) return undefined;
      return { messages };
    } catch { return undefined; }
  });

  // ── L3: before_provider_request — wire-format last resort ──
  pi.on("before_provider_request", (event: any, _ctx: any) => {
    try {
      const { payload, fixes } = sanitizeProviderPayload(event?.payload);
      if (fixes.length === 0) return undefined;
      return payload;
    } catch { return undefined; }
  });

  // ── /sanitize-session — repair the current session file on disk ──
  pi.registerCommand("sanitize-session", {
    description: "修复当前会话文件中的畸形 toolCall 参数（备份 .bak-sanitize，报告修复数量）",
    handler: async (args: string, ctx: any) => {
      let file: string | undefined;
      try { file = ctx?.sessionManager?.getSessionFile?.(); } catch { /* no session */ }
      if (!file || !fs.existsSync(file)) {
        ctx?.ui?.notify?.("[sanitize] 当前无会话文件，无内容可修复", "warn");
        return;
      }
      // Read → repair → backup → atomic swap
      const raw = fs.readFileSync(file, "utf8");
      const { lines, fixes } = sanitizeSessionLines(raw.split("\n"));
      if (fixes.length === 0) {
        ctx?.ui?.notify?.(`[sanitize] 会话文件干净，无需修复（本次运行实时修复 ${liveFixes} 处）`, "info");
        return;
      }
      const backup = `${file}.bak-sanitize`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.sanitize-tmp`);
      fs.writeFileSync(tmp, lines.join("\n"), "utf8");
      fs.renameSync(tmp, file);
      const names = [...new Set(fixes.map((f) => f.toolName))].join(", ");
      ctx?.ui?.notify?.(`[sanitize] 已修复 ${fixes.length} 处畸形参数（${names}），备份: ${path.basename(backup)}`, "info");
    },
  });
}
