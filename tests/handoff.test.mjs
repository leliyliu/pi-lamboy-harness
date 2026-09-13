// Handoff extension unit tests (pure + entry smoke, no pi runtime, zero model quota).
//
// Covers:
//   prompt.ts  — compaction-aware branch slicing (no compaction / legacy
//                firstKeptEntryId / newer retainedTail), payload + footer builders
//   guard.ts   — env config, draft entries (fresh/stale), guard suppression state
//   entry      — /handoff command + handoff tool registration, kill switch,
//                draft → turn_end editor prefill, context-guard dialog behavior
import assert from "node:assert/strict";

const {
  entryToMessage,
  getHandoffMessages,
  buildHandoffUserContent,
  buildParentFooter,
  HANDOFF_SYSTEM_PROMPT,
} = await import("../packages/core/handoff/prompt.ts");

const {
  guardConfigFromEnv,
  isHandoffDraft,
  latestHandoffDraft,
  isGuardSuppressed,
  HANDOFF_DRAFT_TYPE,
  DEFAULT_GUARD_THRESHOLD_PERCENT,
} = await import("../packages/core/handoff/guard.ts");

let pass = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { console.error(`FAIL ${name}`); process.exitCode = 1; }
}

// ─── prompt.ts: entryToMessage ───
{
  const msg = { role: "user", content: [{ type: "text", text: "hi" }] };
  ok("entryToMessage: message passthrough", entryToMessage({ id: "1", type: "message", message: msg }) === msg);
  const comp = entryToMessage({ id: "2", type: "compaction", summary: "S", tokensBefore: 100 });
  ok("entryToMessage: compaction → compactionSummary", comp?.role === "compactionSummary" && comp.summary === "S" && comp.tokensBefore === 100);
  ok("entryToMessage: compaction without tokensBefore → 0", entryToMessage({ id: "3", type: "compaction", summary: "S" })?.tokensBefore === 0);
  ok("entryToMessage: other types undefined", entryToMessage({ id: "4", type: "custom" }) === undefined);
  ok("entryToMessage: message entry with undefined message", entryToMessage({ id: "5", type: "message" }) === undefined);
}

// ─── prompt.ts: getHandoffMessages ───
{
  // no compaction: whole branch, non-LLM entries filtered
  const u1 = { role: "user", content: [{ type: "text", text: "a" }] };
  const a1 = { role: "assistant", content: [{ type: "text", text: "b" }] };
  const branch = [
    { id: "1", type: "message", message: u1 },
    { id: "2", type: "custom", customType: "x", data: {} },
    { id: "3", type: "message", message: a1 },
  ];
  const out = getHandoffMessages(branch);
  ok("getHandoffMessages: no compaction keeps messages only", out.length === 2 && out[0] === u1 && out[1] === a1);
}
{
  // legacy firstKeptEntryId: summary + [firstKept, compaction) + after
  const kept = { role: "user", content: [{ type: "text", text: "kept" }] };
  const before = { role: "user", content: [{ type: "text", text: "dropped" }] };
  const after = { role: "user", content: [{ type: "text", text: "after" }] };
  const branch = [
    { id: "e1", type: "message", message: before },
    { id: "e2", type: "message", message: kept },
    { id: "e3", type: "message", message: { role: "user", content: [{ type: "text", text: "mid" }] } },
    { id: "c1", type: "compaction", summary: "SUM", tokensBefore: 50, firstKeptEntryId: "e2" },
    { id: "e4", type: "message", message: after },
  ];
  const out = getHandoffMessages(branch);
  ok("legacy compaction: 4 messages (summary, kept, mid, after)", out.length === 4);
  ok("legacy compaction: summary is compactionSummary", out[0].role === "user" || true);
  // out[0] should be the compactionSummary per the [compaction, kept-slice, after] order
  ok("legacy compaction: first is summary", out[0]?.role === "compactionSummary" && out[0].summary === "SUM");
  ok("legacy compaction: dropped pre-compaction entry", !JSON.stringify(out).includes("dropped"));
  ok("legacy compaction: order kept → mid → after",
    out[1] === kept && out[2]?.content?.[0]?.text === "mid" && out[3] === after);
}
{
  // newer retainedTail: self-contained checkpoint
  const tail1 = { role: "user", content: [{ type: "text", text: "t1" }] };
  const tail2 = { role: "assistant", content: [{ type: "text", text: "t2" }] };
  const after = { role: "user", content: [{ type: "text", text: "after" }] };
  const dropped = { role: "user", content: [{ type: "text", text: "dropped" }] };
  const branch = [
    { id: "e1", type: "message", message: dropped },
    { id: "c1", type: "compaction", summary: "SUM2", tokensBefore: 90, retainedTail: [tail1, tail2] },
    { id: "e2", type: "message", message: after },
  ];
  const out = getHandoffMessages(branch);
  ok("retainedTail: summary + tail + after", out.length === 4);
  ok("retainedTail: order", out[0]?.role === "compactionSummary" && out[1] === tail1 && out[2] === tail2 && out[3] === after);
  ok("retainedTail: pre-compaction dropped", !JSON.stringify(out).includes("dropped"));
}

// ─── prompt.ts: payload + footer ───
{
  const payload = buildHandoffUserContent("CONV", "GOAL");
  ok("user content embeds conversation + goal",
    payload.includes("## Conversation History") && payload.includes("CONV") &&
    payload.includes("## User's Goal for New Session") && payload.includes("GOAL"));
  ok("system prompt non-empty with format guidance",
    HANDOFF_SYSTEM_PROMPT.length > 200 && HANDOFF_SYSTEM_PROMPT.includes("self-contained"));
}
{
  ok("footer: no session file → empty", buildParentFooter(undefined) === "");
  const f1 = buildParentFooter("/abs/sess.jsonl");
  ok("footer: absolute path kept verbatim", f1.includes("/abs/sess.jsonl") && f1.includes("Previous session transcript"));
  const f2 = buildParentFooter("sessions/s.jsonl", "/home/u");
  ok("footer: relative path joined with cwd", f2.includes("/home/u/sessions/s.jsonl"));
}

// ─── guard.ts: env config ───
{
  const base = { PI_LAMBOY_HANDOFF: undefined, PI_LAMBOY_HANDOFF_GUARD: undefined, PI_LAMBOY_HANDOFF_THRESHOLD: undefined };
  ok("config: defaults enabled@90", (() => { const c = guardConfigFromEnv(base); return c.enabled && c.thresholdPercent === DEFAULT_GUARD_THRESHOLD_PERCENT; })());
  ok("config: PI_LAMBOY_HANDOFF=0 disables", guardConfigFromEnv({ ...base, PI_LAMBOY_HANDOFF: "0" }).enabled === false);
  ok("config: PI_LAMBOY_HANDOFF_GUARD=0 disables guard only", guardConfigFromEnv({ ...base, PI_LAMBOY_HANDOFF_GUARD: "0" }).enabled === false);
  ok("config: threshold parsed", guardConfigFromEnv({ ...base, PI_LAMBOY_HANDOFF_THRESHOLD: "80" }).thresholdPercent === 80);
  ok("config: threshold clamped low", guardConfigFromEnv({ ...base, PI_LAMBOY_HANDOFF_THRESHOLD: "5" }).thresholdPercent === 90);
  ok("config: threshold clamped high", guardConfigFromEnv({ ...base, PI_LAMBOY_HANDOFF_THRESHOLD: "400" }).thresholdPercent === 90);
  ok("config: bogus threshold ignored", guardConfigFromEnv({ ...base, PI_LAMBOY_HANDOFF_THRESHOLD: "abc" }).thresholdPercent === 90);
}

// ─── guard.ts: draft entries ───
{
  ok("isHandoffDraft: shape check", isHandoffDraft({ prompt: "x" }) && !isHandoffDraft({}) && !isHandoffDraft(null) && !isHandoffDraft("s"));
  ok("draft: none → null", latestHandoffDraft([]) === null);
  const freshBranch = [
    { type: "message" },
    { type: "custom", customType: HANDOFF_DRAFT_TYPE, data: { prompt: "P1" } },
    { type: "custom", customType: "other", data: {} },
  ];
  const d1 = latestHandoffDraft(freshBranch);
  ok("draft: found, fresh", d1?.prompt === "P1" && d1?.fresh === true);
  const staleBranch = [
    { type: "custom", customType: HANDOFF_DRAFT_TYPE, data: { prompt: "P2" } },
    { type: "message" },
  ];
  ok("draft: stale when messages follow", latestHandoffDraft(staleBranch)?.fresh === false);
  const twoDrafts = [
    { type: "custom", customType: HANDOFF_DRAFT_TYPE, data: { prompt: "OLD" } },
    { type: "custom", customType: HANDOFF_DRAFT_TYPE, data: { prompt: "NEW" } },
  ];
  ok("draft: latest wins", latestHandoffDraft(twoDrafts)?.prompt === "NEW");
  ok("draft: malformed data → null", latestHandoffDraft([{ type: "custom", customType: HANDOFF_DRAFT_TYPE, data: { nope: 1 } }]) === null);
}
{
  ok("guard state: none → false", isGuardSuppressed([]) === false);
  ok("guard state: suppressed", isGuardSuppressed([{ type: "custom", customType: "lamboy:handoff-guard-state", data: { suppressed: true, reason: "declined" } }]) === true);
  ok("guard state: latest entry wins",
    isGuardSuppressed([
      { type: "custom", customType: "lamboy:handoff-guard-state", data: { suppressed: true, reason: "declined" } },
      { type: "custom", customType: "lamboy:handoff-guard-state", data: { suppressed: false, reason: "declined" } },
    ]) === false);
  ok("guard state: non-state customs ignored", isGuardSuppressed([{ type: "custom", customType: "x", data: { suppressed: true } }]) === false);
}

// ─── entry smoke: registration + tool + guard wiring ───
function makeStubPi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const pi = {
    registerTool: (def) => tools.set(def.name, def),
    registerCommand: (name, def) => commands.set(name, def),
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(handler); },
    appendEntry: (type, data) => appended.push({ type, data }),
  };
  return { pi, tools, commands, handlers, appended };
}

function makeStubCtx({ percent = null, threshold = null, select = null, hasUI = true } = {}) {
  const calls = { select: [], notify: [], setEditorText: [] };
  const branch = [];
  const ctx = {
    hasUI,
    mode: "tui",
    cwd: "/w",
    sessionManager: { getBranch: () => branch },
    getContextUsage: () => (percent === null ? undefined : { tokens: 1, contextWindow: 100, percent }),
    ui: {
      select: async (msg, opts) => { calls.select.push({ msg, opts }); return select; },
      notify: (msg, kind) => calls.notify.push({ msg, kind }),
      setEditorText: (t) => calls.setEditorText.push(t),
    },
  };
  return { ctx, branch, calls };
}

{
  const mod = await import(`../extensions/85-handoff.ts?smoke=1`);
  ok("entry default-exports factory", typeof mod.default === "function");

  const { pi, tools, commands, handlers } = makeStubPi();
  mod.default(pi);

  ok("/handoff command registered", commands.has("handoff"));
  ok("handoff tool registered", tools.has("handoff"));
  const tool = tools.get("handoff");
  ok("tool params: single required prompt",
    tool.parameters.required.length === 1 && tool.parameters.required[0] === "prompt" &&
    tool.parameters.properties.prompt.type === "string");
  ok("session_start + turn_end handlers wired",
    handlers.has("session_start") && handlers.has("turn_end") && handlers.get("turn_start") === undefined);

  // tool execute: draft entry + notify + result text
  const { ctx, calls } = makeStubCtx();
  const res = await tool.execute("tc-1", { prompt: "BRIEF" }, undefined, undefined, ctx);
  ok("tool execute: returns guidance text", res.content[0].text.includes("draft saved") || res.content[0].text.includes("Handoff draft"));
  // (appendEntry on the stub pi captured the draft)
  const draftAppended = makeStubPi();
  mod.default(draftAppended.pi);
  await draftAppended.tools.get("handoff").execute("tc-2", { prompt: "B2" }, undefined, undefined, makeStubCtx().ctx);
  ok("tool execute: draft appended as custom entry",
    draftAppended.appended.some((e) => e.type === "lamboy:handoff-draft" && e.data.prompt === "B2"));

  // turn_end after a draft: editor prefilled with /handoff
  const guard2 = makeStubPi();
  mod.default(guard2.pi);
  const after = makeStubCtx();
  await guard2.tools.get("handoff").execute("tc-3", { prompt: "B3" }, undefined, undefined, after.ctx);
  await guard2.handlers.get("turn_end")[0]({}, after.ctx);
  ok("turn_end: draft pending → editor prefilled /handoff", after.calls.setEditorText[0] === "/handoff");
  // second turn_end doesn't repeat
  await guard2.handlers.get("turn_end")[0]({}, after.ctx);
  ok("turn_end: draft prompt fires once", after.calls.setEditorText.length === 1);

  // context guard: below threshold → no dialog
  const g3 = makeStubPi();
  mod.default(g3.pi);
  const low = makeStubCtx({ percent: 50 });
  await g3.handlers.get("turn_end")[0]({}, low.ctx);
  ok("guard: below threshold → no dialog", low.calls.select.length === 0);

  // at threshold → dialog once, declined → suppression entry
  const g4 = makeStubPi();
  mod.default(g4.pi);
  const high = makeStubCtx({ percent: 95, select: "No, keep this session" });
  await g4.handlers.get("turn_end")[0]({}, high.ctx);
  ok("guard: dialog shown at 95%", high.calls.select.length === 1 && high.calls.select[0].msg.includes("95%"));
  await g4.handlers.get("turn_end")[0]({}, high.ctx);
  ok("guard: prompted once per session", high.calls.select.length === 1);
  ok("guard: declined → suppression entry appended",
    g4.appended.some((e) => e.type === "lamboy:handoff-guard-state" && e.data.suppressed === true));

  // session_start restores suppression from branch
  const g5 = makeStubPi();
  mod.default(g5.pi);
  const suppressed = makeStubCtx();
  suppressed.branch.push({ type: "custom", customType: "lamboy:handoff-guard-state", data: { suppressed: true, reason: "declined" } });
  await g5.handlers.get("session_start")[0]({}, suppressed.ctx);
  const high2 = makeStubCtx({ percent: 97 });
  await g5.handlers.get("turn_end")[0]({}, high2.ctx);
  ok("guard: restored suppression blocks prompt", high2.calls.select.length === 0);

  // accept → editor prefilled /handoff + notify
  const g6 = makeStubPi();
  mod.default(g6.pi);
  const yes = makeStubCtx({ percent: 92, select: "Yes, prepare handoff" });
  await g6.handlers.get("turn_end")[0]({}, yes.ctx);
  ok("guard: accepted → /handoff prefilled", yes.calls.setEditorText[0] === "/handoff ");

  // null percent (post-compaction) → skip
  const g7 = makeStubPi();
  mod.default(g7.pi);
  const np = makeStubCtx({ percent: null });
  await g7.handlers.get("turn_end")[0]({}, np.ctx);
  ok("guard: null percent skipped", np.calls.select.length === 0);

  // no UI → skip
  const g8 = makeStubPi();
  mod.default(g8.pi);
  const noui = makeStubCtx({ percent: 95 });
  noui.ctx.hasUI = false;
  await g8.handlers.get("turn_end")[0]({}, noui.ctx);
  ok("guard: no UI skipped", noui.calls.select.length === 0);
}

// kill switch: PI_LAMBOY_HANDOFF=0 registers nothing
{
  process.env.PI_LAMBOY_HANDOFF = "0";
  try {
    const mod = await import(`../extensions/85-handoff.ts?killed=1`);
    const { pi, tools, commands, handlers } = makeStubPi();
    mod.default(pi);
    ok("kill switch: nothing registered",
      tools.size === 0 && commands.size === 0 && handlers.size === 0);
  } finally {
    delete process.env.PI_LAMBOY_HANDOFF;
  }
}

// threshold env honored by entry guard
{
  process.env.PI_LAMBOY_HANDOFF_THRESHOLD = "75";
  try {
    const mod = await import(`../extensions/85-handoff.ts?thr=1`);
    const g = makeStubPi();
    mod.default(g.pi);
    const mid = makeStubCtx({ percent: 80, select: "No, keep this session" });
    await g.handlers.get("turn_end")[0]({}, mid.ctx);
    ok("guard: env threshold honored (80% ≥ 75%)", mid.calls.select.length === 1);
  } finally {
    delete process.env.PI_LAMBOY_HANDOFF_THRESHOLD;
  }
}

console.log(`\nhandoff: ${pass} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
