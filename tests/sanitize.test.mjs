// Sanitize unit tests (pure, no pi runtime, no model quota).
//
// Root cause this guards against: a provider (observed: jdcloud/GLM-5.3)
// occasionally emits a toolCall whose `arguments` is a top-level JSON
// *array* (e.g. [{path, content}, ["stray", "fragments"]]). pi rejects
// execution locally but keeps the malformed structure in session history;
// every subsequent request then fails with 400 / code 1210 and the session
// dead-locks. These tests pin the normalization rules that keep requests
// clean.

const {
  normalizeToolCallArgs,
  sanitizeMessages,
  sanitizeProviderPayload,
  sanitizeSessionLines,
} = await import("../packages/core/sanitize/index.ts");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ──────────────────────────────────────────────────────────────
// 1. normalizeToolCallArgs — per-shape rules
// ──────────────────────────────────────────────────────────────
{
  // undefined / missing → leave alone (provider omits it)
  eq("undefined untouched", normalizeToolCallArgs(undefined).args, undefined);
  check("undefined unchanged flag", normalizeToolCallArgs(undefined).changed === false);

  // plain object → untouched, same reference
  const obj = { path: "/tmp/x", content: "hi" };
  const r1 = normalizeToolCallArgs(obj);
  check("object same ref", r1.args === obj);
  check("object unchanged flag", r1.changed === false);

  // ARRAY (the incident shape) → first object element
  const arr = [{ path: "/tmp/x", content: "hi" }, ["stray", "frag"]];
  const r2 = normalizeToolCallArgs(arr);
  eq("array → first object el", r2.args, { path: "/tmp/x", content: "hi" });
  check("array changed flag", r2.changed === true);

  // array without any object element → {}
  eq("array of strings → {}", normalizeToolCallArgs(["a", "b"]).args, {});
  eq("empty array → {}", normalizeToolCallArgs([]).args, {});
  eq("array of nulls → {}", normalizeToolCallArgs([null, null]).args, {});
  check("array of strings changed", normalizeToolCallArgs(["a"]).changed === true);

  // STRING → JSON.parse round
  eq("json-string object → parsed", normalizeToolCallArgs('{"path":"/x"}').args, { path: "/x" });
  eq("json-string array → first obj el", normalizeToolCallArgs('[{"a":1},["x"]]').args, { a: 1 });
  eq("invalid json string → {}", normalizeToolCallArgs("not json").args, {});
  eq("json-string number → {}", normalizeToolCallArgs("42").args, {});
  check("string changed flag", normalizeToolCallArgs('{"a":1}').changed === true);

  // primitives → {}
  eq("null → {}", normalizeToolCallArgs(null).args, {});
  eq("number → {}", normalizeToolCallArgs(7).args, {});
  eq("boolean → {}", normalizeToolCallArgs(true).args, {});
  check("null changed flag", normalizeToolCallArgs(null).changed === true);
}

// ──────────────────────────────────────────────────────────────
// 2. sanitizeMessages — message-level walk
// ──────────────────────────────────────────────────────────────
{
  const poisoned = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "..." },
      { type: "toolCall", id: "c1", name: "write", arguments: [{ path: "/a", content: "x" }, ["frag"]] },
    ],
  };
  const clean = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  const user = { role: "user", content: [{ type: "text", text: "go" }] };
  const toolRes = { role: "toolResult", content: [{ type: "text", text: "ok" }] };

  // no malformed → SAME reference back (zero-copy guarantee)
  const cleanList = [user, clean, toolRes];
  const r0 = sanitizeMessages(cleanList);
  check("clean list same ref", r0.messages === cleanList);
  eq("clean list no fixes", r0.fixes, []);

  // mixed → only the poisoned message replaced, others by reference
  const list = [user, poisoned, clean, toolRes];
  const r = sanitizeMessages(list);
  check("returns new array when fixed", r.messages !== list);
  check("user msg same ref", r.messages[0] === user);
  check("poisoned msg replaced", r.messages[1] !== poisoned);
  check("clean msg same ref", r.messages[2] === clean);
  eq("arguments normalized", r.messages[1].content[1].arguments, { path: "/a", content: "x" });
  check("fix recorded", r.fixes.length === 1 && r.fixes[0].toolName === "write");
  check("fix has kind", typeof r.fixes[0].kind === "string");

  // only assistant messages are touched
  const userPoisoned = {
    role: "user",
    content: [{ type: "toolCall", name: "write", arguments: [{ a: 1 }, ["x"]] }],
  };
  const r2 = sanitizeMessages([userPoisoned]);
  check("non-assistant untouched", r2.messages === [userPoisoned] || r2.messages[0] === userPoisoned);
  eq("non-assistant no fixes", r2.fixes, []);

  // malformed container shapes never throw
  check("null entries safe", sanitizeMessages([null, undefined, 42]).messages.length === 3);
  check("content non-array safe", sanitizeMessages([{ role: "assistant", content: "text" }]).fixes.length === 0);
  check("null content safe", sanitizeMessages([{ role: "assistant", content: null }]).fixes.length === 0);
}

// ──────────────────────────────────────────────────────────────
// 3. sanitizeProviderPayload — wire-format safety net
// ──────────────────────────────────────────────────────────────
{
  // openai-completions: tool_calls[].function.arguments is a JSON *string*
  const payloadOk = {
    model: "GLM-5.3",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "write", arguments: '{"path":"/a","content":"x"}' } },
      ] },
    ],
  };
  const r0 = sanitizeProviderPayload(payloadOk);
  check("openai valid payload same ref", r0.payload === payloadOk);
  eq("openai valid no fixes", r0.fixes, []);

  const payloadBad = {
    model: "GLM-5.3",
    messages: [
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "write", arguments: '[{"path":"/a","content":"x"},["frag"]]' } },
      ] },
    ],
  };
  const r1 = sanitizeProviderPayload(payloadBad);
  check("openai poisoned payload replaced", r1.payload !== payloadBad);
  const reparsed = JSON.parse(r1.payload.messages[0].tool_calls[0].function.arguments);
  eq("openai arguments re-stringified object", reparsed, { path: "/a", content: "x" });

  // anthropic-messages: content[].type === "tool_use" with .input object
  const anthro = {
    model: "claude",
    messages: [
      { role: "assistant", content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "write", input: [{ path: "/a" }, ["frag"]] },
      ] },
    ],
  };
  const r2 = sanitizeProviderPayload(anthro);
  eq("anthropic tool_use input normalized", r2.payload.messages[0].content[1].input, { path: "/a" });

  // openai-responses: input[].type === "function_call" with .arguments string
  const resp = {
    model: "gpt",
    input: [
      { type: "function_call", call_id: "c1", name: "write", arguments: '[{"path":"/a"},["f"]]' },
    ],
  };
  const r3 = sanitizeProviderPayload(resp);
  eq("responses function_call arguments normalized", JSON.parse(r3.payload.input[0].arguments), { path: "/a" });

  // malformed payload shapes never throw
  check("null payload safe", sanitizeProviderPayload(null).payload === null);
  check("empty payload safe", sanitizeProviderPayload({}).payload === ({}).valueOf() || sanitizeProviderPayload({}).fixes.length === 0);
  check("weird messages safe", sanitizeProviderPayload({ messages: "nope" }).fixes.length === 0);
}

// ──────────────────────────────────────────────────────────────
// 4. sanitizeSessionLines — session-file repair (pure)
// ──────────────────────────────────────────────────────────────
{
  const goodLine = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  const poisonedEntry = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "write", arguments: [{ path: "/a", content: "x" }, ["frag"]] }],
    },
  };
  const poisonedLine = JSON.stringify(poisonedEntry);
  const headerLine = JSON.stringify({ type: "session", version: "3", id: "s1" });

  const r = sanitizeSessionLines([headerLine, goodLine, poisonedLine, ""]);
  check("line count preserved", r.lines.length === 4);
  check("one fix", r.fixes.length === 1);
  const repaired = JSON.parse(r.lines[2]);
  eq("session line arguments fixed", repaired.message.content[0].arguments, { path: "/a", content: "x" });
  check("header line untouched", r.lines[0] === headerLine);
  check("good line untouched", r.lines[1] === goodLine);
  check("empty line preserved", r.lines[3] === "");

  // unparseable lines pass through untouched
  const r2 = sanitizeSessionLines(["{broken json", goodLine]);
  check("broken line preserved", r2.lines[0] === "{broken json");
  eq("broken line no fixes", r2.fixes, []);

  // already-clean session → same lines back
  const r3 = sanitizeSessionLines([headerLine, goodLine]);
  check("clean session same ref", r3.lines === [headerLine, goodLine] || (r3.lines[0] === headerLine && r3.lines[1] === goodLine));
}

// ──────────────────────────────────────────────────────────────
// 5. Extension wiring — stub pi, fake events
// ──────────────────────────────────────────────────────────────
{
  const mod = await import("../extensions/82-sanitize.ts");
  const handlers = {};
  const commands = {};
  let notifications = [];
  const pi = {
    on: (event, fn) => { handlers[event] = fn; },
    registerCommand: (name, opts) => { commands[name] = opts; },
  };
  mod.default(pi);
  const ctx = { ui: { notify: (msg, level) => notifications.push([msg, level]) } };

  // all three hooks registered
  check("context handler registered", typeof handlers.context === "function");
  check("message_end handler registered", typeof handlers.message_end === "function");
  check("before_provider_request handler registered", typeof handlers.before_provider_request === "function");
  check("/sanitize-session registered", typeof commands["sanitize-session"] === "object");

  // message_end: assistant with array args → returns {message} fixed
  const badMsg = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "write", arguments: [{ path: "/a" }, ["f"]] }],
  };
  const r1 = handlers.message_end({ message: badMsg }, ctx);
  check("message_end returns replacement", r1 && typeof r1.message === "object");
  eq("message_end fixed args", r1.message.content[0].arguments, { path: "/a" });
  check("message_end notified once", notifications.length === 1);

  // message_end: clean user message → no replacement
  check("message_end user passthrough", handlers.message_end({ message: { role: "user", content: [] } }, ctx) === undefined);

  // context: poisoned history → {messages} fixed
  const r2 = handlers.context({ messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: [{ command: "ls" }] }] }] }, ctx);
  check("context returns fixed messages", r2 && Array.isArray(r2.messages));
  eq("context fixed args", r2.messages[0].content[0].arguments, { command: "ls" });
  // context-level fixes are silent (no repeated notify)
  check("context does not notify", notifications.length === 1);

  // context: clean → undefined
  check("context clean passthrough", handlers.context({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, ctx) === undefined);

  // before_provider_request: poisoned openai payload → fixed payload object
  const r3 = handlers.before_provider_request({ payload: {
    messages: [{ role: "assistant", tool_calls: [{ function: { name: "write", arguments: '[{"path":"/a"},["f"]]' } }] }],
  } }, ctx);
  check("provider payload returned", r3 && typeof r3 === "object");
  eq("provider payload fixed", JSON.parse(r3.messages[0].tool_calls[0].function.arguments), { path: "/a" });

  // before_provider_request: clean → undefined
  check("provider clean passthrough", handlers.before_provider_request({ payload: { messages: [] } }, ctx) === undefined);

  // every hook is exception-safe (garbage in → undefined out, never throws)
  let threw = false;
  try {
    handlers.context(null, null);
    handlers.message_end(null, null);
    handlers.before_provider_request(null, null);
  } catch { threw = true; }
  check("hooks never throw on garbage", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
