// SoL-Pi trimmed entry (extensions/96-solpi.ts) — registration smoke test.
// Zero-spend: loads the real vendored SoL-Pi sources through the same
// import chain pi uses, with a stub ExtensionAPI. Verifies:
//   1. edit/write are replaced (parameters gain `then_run`)  [Action Fusion]
//   2. obs_recall tool is registered                           [ObservationPack]
//   3. the context projection hook is installed
//   4. PI_LAMBOY_SOLPI=0 disables the whole entry (kill switch)
import assert from "node:assert/strict";

function makeStubPi() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (def) => tools.set(def.name ?? "edit-or-write", def),
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
  return { pi, tools, handlers };
}

// 1–3: default (enabled) path — fresh import via cache-busting query.
{
  const mod = await import(`../extensions/96-solpi.ts?enabled=1`);
  assert.equal(typeof mod.default, "function", "96-solpi.ts must default-export a factory");

  const { pi, tools, handlers } = makeStubPi();
  mod.default(pi);

  const names = [...tools.keys()].sort();
  assert.deepEqual(
    names,
    ["edit", "obs_recall", "write"],
    `expected edit/write (Action Fusion) + obs_recall (ObservationPack), got: ${names.join(", ")}`,
  );

  // Action Fusion: the replacement edit/write gain the then_run parameter.
  assert.ok(tools.get("edit").parameters.properties.then_run, "replaced edit must expose then_run");
  assert.ok(tools.get("write").parameters.properties.then_run, "replaced write must expose then_run");

  // ObservationPack: context projection hook installed.
  assert.ok(handlers.has("context") && handlers.get("context").length === 1, "context projection hook missing");

  console.log("PASS solpi: edit/write replaced with then_run (Action Fusion)");
  console.log("PASS solpi: obs_recall registered (ObservationPack)");
  console.log("PASS solpi: context projection hook installed");
}

// 4: kill switch — PI_LAMBOY_SOLPI=0 must register nothing.
{
  process.env.PI_LAMBOY_SOLPI = "0";
  try {
    const mod = await import(`../extensions/96-solpi.ts?killed=1`);
    const { pi, tools, handlers } = makeStubPi();
    mod.default(pi);
    assert.equal(tools.size, 0, "kill switch must prevent tool registration");
    assert.equal(handlers.size, 0, "kill switch must prevent hook registration");
    console.log("PASS solpi: PI_LAMBOY_SOLPI=0 disables the entry");
  } finally {
    delete process.env.PI_LAMBOY_SOLPI;
  }
}
