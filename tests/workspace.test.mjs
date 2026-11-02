// Workspace label resolver tests (pure, no pi runtime, no model quota).
//
// resolveWorkspace() answers "which workspace is this agent in?" for
// attention notifications and the approval panel. Source of truth, in order:
//   1. Paseo's local records (~/.paseo/projects/{workspaces,projects}.json)
//      keyed by PASEO_WORKSPACE_ID — but ONLY when the record's cwd matches
//      the cwd being asked about (a pi-subagents lane inherits the parent's
//      env while running in its own worktree).
//   2. Paseo-managed worktree paths (<PASEO_HOME>/worktrees/<hash>/<slug>).
//   3. basename(cwd).
// TS loading strategy matches tests/permission.test.mjs (jiti transform +
// shared module cache).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { jitiUrl } from "./jiti-path.mjs";
const { createJiti } = await import(jitiUrl());
const jiti = createJiti(import.meta.url ?? __filename, { moduleCache: false });
const nativeRequire = createRequire(import.meta.url);
const moduleCache = new Map();

function resolveSpec(spec, parentFile) {
  if (!spec.startsWith(".")) return { native: spec };
  const clean = spec.endsWith(".js") ? spec.slice(0, -3) : spec;
  const base = path.resolve(path.dirname(parentFile), clean);
  for (const c of [base + ".ts", base + ".js", base]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c };
  }
  throw new Error(`Cannot resolve ${spec} from ${parentFile}`);
}

function loadTs(file) {
  const key = path.resolve(file);
  if (moduleCache.has(key)) return moduleCache.get(key).exports;
  const code = jiti.transform({ source: fs.readFileSync(key, "utf8"), filename: key, ts: true });
  const module = { exports: {} };
  moduleCache.set(key, module);
  const localRequire = (spec) => {
    const r = resolveSpec(spec, key);
    return r.native ? nativeRequire(spec) : loadTs(r.file);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", code)(
    module.exports, localRequire, module, key, path.dirname(key));
  return module.exports;
}

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const ws = loadTs(`${EXT}/packages/core/workspace/index.ts`);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// ── Fixture: a fake Paseo home ─────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ws-home-"));
const projectsDir = path.join(home, "projects");
fs.mkdirSync(projectsDir, { recursive: true });
const localCwd = path.join(home, "checkout", "pi-lamboy-harness");
const dirCwd = path.join(home, "checkout", "policy-optimization");
const otherCwd = path.join(home, "checkout", "kv-simulator");
const worktreeCwd = path.join(home, "worktrees", "1imxhu9i", "verify-wt-setup");
for (const d of [localCwd, dirCwd, otherCwd, worktreeCwd]) fs.mkdirSync(d, { recursive: true });

const WORKSPACES = [
  // local checkout: title is null → label must be the project name (never "main")
  { workspaceId: "wks_local", projectId: "prj_harness", cwd: localCwd, kind: "local_checkout", displayName: "main", title: null, branch: "main", archivedAt: null },
  // directory workspace: title is meaningful → "project · title"
  { workspaceId: "wks_dir", projectId: "prj_policy", cwd: dirCwd, kind: "directory", displayName: "policy-optimization", title: "短文桶驱逐策略优化", branch: null, archivedAt: null },
  // archived duplicate of the same cwd: the live record must win
  { workspaceId: "wks_archived", projectId: "prj_policy", cwd: dirCwd, kind: "directory", displayName: "policy-optimization", title: "旧标题已归档", branch: null, archivedAt: "2026-10-01T00:00:00.000Z" },
  { workspaceId: "wks_other", projectId: "prj_kv", cwd: otherCwd, kind: "local_checkout", displayName: "main", title: null, branch: "main", archivedAt: null },
  // worktree workspace whose title metadata was never generated: the slug is
  // the only thing that keeps it apart from the project's main checkout.
  { workspaceId: "wks_wt", projectId: "prj_harness", cwd: worktreeCwd, kind: "worktree", displayName: "verify-wt-setup", title: null, branch: "verify-wt-setup", archivedAt: null },
];
const PROJECTS = [
  { projectId: "prj_harness", rootPath: localCwd, displayName: "pi-lamboy-harness" },
  { projectId: "prj_policy", rootPath: dirCwd, displayName: "policy-optimization" },
  { projectId: "prj_kv", rootPath: otherCwd, displayName: "kv-simulator" },
];
const workspacesFile = path.join(projectsDir, "workspaces.json");
const projectsFile = path.join(projectsDir, "projects.json");
fs.writeFileSync(workspacesFile, JSON.stringify(WORKSPACES));
fs.writeFileSync(projectsFile, JSON.stringify(PROJECTS));

const env = (id, homePath = home) => ({ PASEO_HOME: homePath, PASEO_WORKSPACE_ID: id });

// ── 1. Paseo hit: local checkout without a title → project name ───────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(localCwd, env("wks_local"));
  check("local_checkout: source is paseo", r.source === "paseo", r.source);
  check("local_checkout: label is the project name", r.label === "pi-lamboy-harness", r.label);
  check("local_checkout: label never leaks 'main'", r.label !== "main", r.label);
  check("local_checkout: project/branch exposed", r.project === "pi-lamboy-harness" && r.branch === "main");
}

// ── 2. Paseo hit: titled workspace → "project · title" ────────────────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(dirCwd, env("wks_dir"));
  check("titled workspace: label combines project and title",
    r.label === "policy-optimization · 短文桶驱逐策略优化", r.label);
  check("titled workspace: full label kept", r.labelFull === r.label, r.labelFull);
}

// ── 3. Paseo hit: archived duplicates never shadow the live record ────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(dirCwd, env("wks_archived"));
  check("archived id: archived record is not used", /旧标题/.test(r.label) === false, r.label);
}

// ── 4. No PASEO_WORKSPACE_ID (plain terminal) → basename(cwd) ─────────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace("/Users/someone/projects/plain-repo", { HOME: home });
  check("no paseo env: source is path", r.source === "path", r.source);
  check("no paseo env: label is the directory name", r.label === "plain-repo", r.label);
}

// ── 5. Unknown workspace id → basename(cwd), no throw ─────────────────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(otherCwd, env("wks_does_not_exist"));
  check("unknown id: falls back to the directory name", r.label === "kv-simulator", r.label);
  check("unknown id: source is path", r.source === "path", r.source);
}

// ── 6. Missing / malformed Paseo records → fallback, never throws ────────
{
  ws.resetWorkspaceCache();
  check("missing home: no throw", (() => {
    try { ws.resolveWorkspace(otherCwd, env("wks_other", path.join(home, "nope"))); return true; } catch { return false; }
  })());

  const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), "ws-broken-"));
  fs.mkdirSync(path.join(brokenHome, "projects"), { recursive: true });
  fs.writeFileSync(path.join(brokenHome, "projects", "workspaces.json"), "{not json");
  fs.writeFileSync(path.join(brokenHome, "projects", "projects.json"), "[1,2,3]");
  ws.resetWorkspaceCache();
  let threw = false;
  let label = "";
  try { label = ws.resolveWorkspace(otherCwd, env("wks_other", brokenHome)).label; }
  catch { threw = true; }
  check("broken json: no throw", threw === false);
  check("broken json: directory-name fallback", label === "kv-simulator", label);
}

// ── 7. cwd mismatch (subagent lane inheriting the parent's env) ──────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(otherCwd, env("wks_local")); // env says harness, cwd says kv-simulator
  check("cwd mismatch: does not reuse the parent workspace name", r.label !== "pi-lamboy-harness", r.label);
  check("cwd mismatch: falls back to the actual directory", r.label === "kv-simulator", r.label);
}

// ── 8. Paseo-managed worktree path (no matching record) ──────────────────
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(worktreeCwd, env("wks_missing"));
  check("worktree path: label is the worktree slug", r.label === "verify-wt-setup", r.label);
  check("worktree path: source is worktree", r.source === "worktree", r.source);
}

// ── 8b. Worktree record WITHOUT a title → project · slug (not just project) ──
{
  ws.resetWorkspaceCache();
  const r = ws.resolveWorkspace(worktreeCwd, env("wks_wt"));
  check("worktree record without title: keeps the slug",
    r.label === "pi-lamboy-harness · verify-wt-setup", r.label);
  check("worktree record without title: source is paseo", r.source === "paseo", r.source);
}

// ── 9. Truncation for narrow popups ─────────────────────────────────────
{
  ws.resetWorkspaceCache();
  const long = ws.resolveWorkspace(dirCwd, env("wks_dir"), 12);
  check("maxLen: label truncated with an ellipsis", long.label.length === 12 && long.label.endsWith("…"), long.label);
  check("maxLen: full label preserved", long.labelFull === "policy-optimization · 短文桶驱逐策略优化", long.labelFull);
  check("default maxLen: short labels untouched", ws.resolveWorkspace(localCwd, env("wks_local")).label === "pi-lamboy-harness");
}

// ── 10. Cache invalidation on rename (mtime/size change) ─────────────────
{
  ws.resetWorkspaceCache();
  check("cache: pre-rename label", ws.resolveWorkspace(dirCwd, env("wks_dir")).label.includes("短文桶"));
  const renamed = WORKSPACES.map((w) =>
    w.workspaceId === "wks_dir" ? { ...w, title: "缓存命中率面板" } : w);
  fs.writeFileSync(workspacesFile, JSON.stringify(renamed, null, 2)); // size differs → new mtimeMs
  const after = ws.resolveWorkspace(dirCwd, env("wks_dir"));
  check("cache: rename is picked up without a restart", after.label.includes("缓存命中率面板"), after.label);
}

// ── 11. resolveWorkspaceLabel convenience wrapper ───────────────────────
{
  ws.resetWorkspaceCache();
  check("resolveWorkspaceLabel: returns the label string",
    ws.resolveWorkspaceLabel(localCwd, env("wks_local")) === "pi-lamboy-harness");
}

fs.rmSync(home, { recursive: true, force: true });
console.log(fail ? `\n${fail} check(s) FAILED` : `\n${pass} checks passed`);
process.exit(fail ? 1 : 0);
