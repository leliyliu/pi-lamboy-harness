// ============================================================
// Sanitize — normalize malformed toolCall arguments before they
// reach the provider (pure functions, zero dependencies).
//
// Incident (2026-09-13, jdcloud/GLM-5.3): the model occasionally
// emits a toolCall whose `arguments` is a top-level JSON *array*
// (e.g. [{path, content}, ["stray", "fragments"]]). pi rejects
// execution locally ("root: must be object") but keeps the
// malformed structure in session history, so every subsequent
// request fails with 400 / code 1210 and the session dead-locks.
//
// Guarantees:
//   - no malformed arguments ever leave for the provider
//   - clean input is returned BY REFERENCE (zero copy, zero risk)
//   - any garbage input passes through untouched instead of throwing
//
// Layers wired in extensions/82-sanitize.ts:
//   message_end (persist clean + tools execute the fixed args)
//   context (every LLM call, covers already-poisoned sessions)
//   before_provider_request (wire-format last resort)
//   /sanitize-session (repair historical session files)
// ============================================================

/** One recorded repair, for notify/command reporting. */
export interface SanitizeFix {
  /** message role the toolCall lived in ("assistant") */
  role: string;
  /** tool name if known */
  toolName: string;
  /** what was wrong: "array" | "string" | "primitive" */
  kind: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function firstObjectElement(arr: unknown[]): Record<string, unknown> {
  for (const el of arr) if (isPlainObject(el)) return el;
  return {};
}

function kindOf(args: unknown): string {
  if (Array.isArray(args)) return "array";
  if (typeof args === "string") return "string";
  return "primitive";
}

/**
 * Wire-format variant for providers where `arguments` is a JSON STRING
 * (openai-completions tool_calls, openai-responses function_call).
 * A string that parses to a plain object is the CORRECT wire form and is
 * returned untouched (same string); only array/primitive payloads are
 * rewrapped so the provider always receives a JSON object.
 */
function normalizeWireArguments(raw: string): { args: string; changed: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { args: "{}", changed: true }; }
  if (isPlainObject(parsed)) return { args: raw, changed: false };
  const { args } = normalizeToolCallArgs(parsed); // array / primitive → object
  return { args: JSON.stringify(args), changed: true };
}

/**
 * Normalize a single toolCall `arguments` value.
 *
 * Rules (validated against the live jdcloud endpoint, see
 * plans/2026-09-13-glm53-jdcloud-1210-error-analysis.md):
 *   undefined            → untouched (provider omits it)
 *   object               → untouched (the normal case, same reference)
 *   array                → first object element, else {}
 *   JSON string          → parsed; object used, array unwrapped as above
 *   anything else        → {}
 */
export function normalizeToolCallArgs(args: unknown): { args: unknown; changed: boolean } {
  if (args === undefined) return { args, changed: false };
  if (isPlainObject(args)) return { args, changed: false };
  if (Array.isArray(args)) return { args: firstObjectElement(args), changed: true };
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isPlainObject(parsed)) return { args: parsed, changed: true };
      if (Array.isArray(parsed)) return { args: firstObjectElement(parsed), changed: true };
    } catch { /* not JSON */ }
    return { args: {}, changed: true };
  }
  return { args: {}, changed: true }; // null / number / boolean
}

/**
 * Sanitize an array of pi messages (AppMessage shape: {role, content[]}).
 * Only assistant toolCall blocks are inspected. Returns the SAME array
 * reference when nothing needed fixing.
 */
export function sanitizeMessages(messages: any[]): { messages: any[]; fixes: SanitizeFix[] } {
  if (!Array.isArray(messages)) return { messages, fixes: [] };
  const fixes: SanitizeFix[] = [];
  let anyChanged = false;
  const out = messages.map((msg) => {
    if (!isPlainObject(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
    let msgChanged = false;
    const newContent = msg.content.map((block: any) => {
      if (!isPlainObject(block) || block.type !== "toolCall" || !("arguments" in block)) return block;
      const { args, changed } = normalizeToolCallArgs(block.arguments);
      if (!changed) return block;
      msgChanged = true;
      fixes.push({
        role: "assistant",
        toolName: typeof block.name === "string" ? block.name : "?",
        kind: kindOf(block.arguments),
      });
      return { ...block, arguments: args };
    });
    if (!msgChanged) return msg;
    anyChanged = true;
    return { ...msg, content: newContent };
  });
  return { messages: anyChanged ? out : messages, fixes };
}

/**
 * Sanitize a provider request payload as a last-resort safety net.
 * Handles the three wire shapes pi emits:
 *   openai-completions: messages[].tool_calls[].function.arguments (JSON string)
 *   anthropic-messages: messages[].content[].tool_use.input (object)
 *   openai-responses:  input[].function_call.arguments (JSON string)
 * Returns the SAME payload reference when nothing needed fixing.
 */
export function sanitizeProviderPayload(payload: any): { payload: any; fixes: SanitizeFix[] } {
  if (!isPlainObject(payload)) return { payload, fixes: [] };
  const fixes: SanitizeFix[] = [];
  let out = payload;

  // openai-completions + anthropic share `messages`
  if (Array.isArray(payload.messages)) {
    let msgsChanged = false;
    const newMsgs = payload.messages.map((msg: any) => {
      if (!isPlainObject(msg)) return msg;
      let msgChanged = false;
      let next: any = msg;

      // openai-completions: tool_calls[].function.arguments is a JSON string
      if (Array.isArray(msg.tool_calls)) {
        const newTcs = msg.tool_calls.map((tc: any) => {
          if (!isPlainObject(tc) || !isPlainObject(tc.function) || typeof tc.function.arguments !== "string") return tc;
          const { args, changed } = normalizeWireArguments(tc.function.arguments);
          if (!changed) return tc;
          fixes.push({ role: "assistant", toolName: typeof tc.function.name === "string" ? tc.function.name : "?", kind: "string" });
          msgChanged = true;
          return { ...tc, function: { ...tc.function, arguments: args } };
        });
        if (msgChanged) next = { ...next, tool_calls: newTcs };
      }

      // anthropic: content[].tool_use.input is an object
      if (Array.isArray(msg.content)) {
        let contentChanged = false;
        const newContent = msg.content.map((block: any) => {
          if (!isPlainObject(block) || block.type !== "tool_use") return block;
          const { args, changed } = normalizeToolCallArgs(block.input);
          if (!changed) return block;
          fixes.push({ role: "assistant", toolName: typeof block.name === "string" ? block.name : "?", kind: kindOf(block.input) });
          contentChanged = true;
          return { ...block, input: args };
        });
        if (contentChanged) { next = { ...next, content: newContent }; msgChanged = true; }
      }

      if (msgChanged) { msgsChanged = true; return next; }
      return msg;
    });
    if (msgsChanged) out = { ...out, messages: newMsgs };
  }

  // openai-responses: input[].function_call.arguments is a JSON string
  if (Array.isArray(payload.input)) {
    let inputChanged = false;
    const newInput = payload.input.map((item: any) => {
      if (!isPlainObject(item) || item.type !== "function_call" || typeof item.arguments !== "string") return item;
      const { args, changed } = normalizeWireArguments(item.arguments);
      if (!changed) return item;
      fixes.push({ role: "assistant", toolName: typeof item.name === "string" ? item.name : "?", kind: "string" });
      inputChanged = true;
      return { ...item, arguments: args };
    });
    if (inputChanged) out = { ...out, input: newInput };
  }

  return { payload: out, fixes };
}

/**
 * Repair the lines of a pi session file (.jsonl, one entry per line).
 * Each entry has shape {type: "message", message: {role, content[]}}.
 * Unparseable / non-message lines pass through untouched. Returns the
 * SAME array reference when nothing needed fixing.
 */
export function sanitizeSessionLines(lines: string[]): { lines: string[]; fixes: SanitizeFix[] } {
  if (!Array.isArray(lines)) return { lines, fixes: [] };
  const fixes: SanitizeFix[] = [];
  let anyChanged = false;
  const out = lines.map((line) => {
    if (typeof line !== "string" || line.trim() === "") return line;
    let entry: any;
    try { entry = JSON.parse(line); } catch { return line; } // keep broken lines verbatim
    if (!isPlainObject(entry) || entry.type !== "message" || !isPlainObject(entry.message)) return line;
    const { messages, fixes: msgFixes } = sanitizeMessages([entry.message]);
    if (msgFixes.length === 0) return line;
    anyChanged = true;
    fixes.push(...msgFixes);
    return JSON.stringify({ ...entry, message: messages[0] });
  });
  return { lines: anyChanged ? out : lines, fixes };
}
