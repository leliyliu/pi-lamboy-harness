// ============================================================
// Workspace — "which workspace is this agent in?" label resolver.
//
// Why: with several Paseo workspaces (local checkouts + isolated git
// worktrees) running at once, an approval popup that only says
// "🔐 需要授权 bash: rm -rf …" gives no way to tell WHICH agent is blocked.
// The desktop notifier already names the project for "settled" events
// (personal/extensions/notify.ts), so approval/ask/plan prompts should too.
//
// Sources, most specific first:
//   1. Paseo's local records — <PASEO_HOME>/projects/workspaces.json
//      (workspaceId → cwd/kind/title/branch/projectId) joined with
//      projects.json (projectId → displayName), keyed by PASEO_WORKSPACE_ID.
//      The record is only trusted when its cwd matches the cwd we were asked
//      about: a pi-subagents lane inherits the parent's env while running in
//      its own worktree, so the env id alone would name the wrong workspace.
//   2. Paseo-managed worktree paths (<PASEO_HOME>/worktrees/<hash>/<slug>).
//   3. basename(cwd) — plain terminals, unknown workspaces, anything broken.
//
// Design constraints:
//   - Pure Node (fs/path/os), zero pi host imports: importable from the
//     personal notifier extension and directly testable.
//   - NEVER throws. This feeds notifications only; a resolution failure must
//     degrade to the directory name, never disturb an approval decision.
//   - No daemon, no subprocess: `paseo workspace ls` costs ~280ms and needs a
//     live daemon, while the two JSON files are an O(1) read cached by
//     mtime+size (renames in Paseo show up on the next prompt, no restart).
//   - Reads happen lazily on first call, not at module load.
// ============================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Default label budget. Roomy enough for "repo · 中文标题" (no truncation in
 * the TUI panel); the popup clamps the composed title again for its 348px
 * single-line width (personal/extensions/notify.ts).
 */
export const DEFAULT_LABEL_MAX_LEN = 40;

export type WorkspaceSource = 'paseo' | 'worktree' | 'path';

export interface WorkspaceInfo {
  /** Display label, truncated to the requested budget. */
  label: string;
  /** Untruncated label. */
  labelFull: string;
  /** Project (repo) name, when known. */
  project?: string;
  /** Paseo workspace title, when it carries information beyond the project. */
  title?: string;
  branch?: string;
  /** Paseo workspace kind: local_checkout | directory | worktree. */
  kind?: string;
  source: WorkspaceSource;
}

/** Environment lookup surface (injectable so tests never touch the real home). */
export type WorkspaceEnv = Record<string, string | undefined>;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  data: unknown;
}

const fileCache = new Map<string, CacheEntry>();

/** Test seam: drop every cached Paseo record file. */
export function resetWorkspaceCache(): void {
  fileCache.clear();
}

function readJsonCached(file: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return undefined;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return data;
  } catch {
    // Malformed / partially written file: behave like "no records".
    fileCache.delete(file);
    return undefined;
  }
}

function asRecordList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function paseoHome(env: WorkspaceEnv): string {
  const explicit = text(env.PASEO_HOME);
  if (explicit) return explicit;
  const home = text(env.HOME) ?? os.homedir();
  return path.join(home, '.paseo');
}

/** True when `child` is `parent` or lives inside it (both resolved). */
function sameOrInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
}

/** True when `cwd` is a Paseo-managed worktree checkout. */
function isPaseoWorktreePath(cwd: string, home: string): boolean {
  return sameOrInside(path.join(home, 'worktrees'), cwd);
}

function clamp(label: string, maxLen: number): string {
  if (!Number.isFinite(maxLen) || maxLen <= 1) return label;
  // Code points, not UTF-16 units: never cut a surrogate pair in half.
  const chars = [...label];
  return chars.length <= maxLen ? label : `${chars.slice(0, maxLen - 1).join('')}…`;
}

function projectNameOf(record: Record<string, unknown>, home: string, cwd: string): string | undefined {
  const projectId = text(record.projectId);
  if (projectId) {
    const projects = asRecordList(readJsonCached(path.join(home, 'projects', 'projects.json')));
    const project = projects.find((p) => text(p.projectId) === projectId);
    const name = project ? text(project.displayName) : undefined;
    if (name) return name;
  }
  // displayName is "main" for local checkouts — no information, use the dir.
  const displayName = text(record.displayName);
  if (displayName && displayName !== 'main') return displayName;
  return path.basename(path.resolve(cwd)) || undefined;
}

function fromPaseo(cwd: string, env: WorkspaceEnv): Omit<WorkspaceInfo, 'label'> | undefined {
  const workspaceId = text(env.PASEO_WORKSPACE_ID);
  if (!workspaceId) return undefined;

  const home = paseoHome(env);
  const records = asRecordList(readJsonCached(path.join(home, 'projects', 'workspaces.json')));
  // Archived records are history: Paseo keeps many per cwd, all stale.
  const record = records.find((r) => {
    if (text(r.workspaceId) !== workspaceId) return false;
    // Archived = history. Accept any non-empty marker (ISO string today, but
    // epoch numbers must not slip through as "live").
    const archivedAt = r.archivedAt;
    if (archivedAt !== null && archivedAt !== undefined && archivedAt !== '' && archivedAt !== false) return false;
    const recCwd = text(r.cwd);
    return !!recCwd && sameOrInside(recCwd, cwd);
  });
  if (!record) return undefined;

  const project = projectNameOf(record, home, cwd);
  const title = text(record.title);
  const displayName = text(record.displayName);
  const parts = project ? [project] : [];
  if (title && title !== project && title !== displayName) parts.push(title);
  // A worktree workspace must stay distinguishable from its project's main
  // checkout even when Paseo never generated a title (metadata generation can
  // fail / be unconfigured). The worktree directory name is the slug the user
  // sees in `paseo workspace ls`.
  if (parts.length === 1) {
    const recCwd = text(record.cwd);
    const kind = text(record.kind);
    if (recCwd && (kind === 'worktree' || isPaseoWorktreePath(recCwd, home))) {
      const slug = path.basename(path.resolve(recCwd));
      if (slug && slug !== project) parts.push(slug);
    }
  }
  const labelFull = parts.join(' · ') || path.basename(path.resolve(cwd));

  return {
    labelFull,
    project,
    title,
    branch: text(record.branch),
    kind: text(record.kind),
    source: 'paseo',
  };
}

function fromWorktreePath(cwd: string, env: WorkspaceEnv): Omit<WorkspaceInfo, 'label'> | undefined {
  const root = path.join(paseoHome(env), 'worktrees');
  const resolved = path.resolve(cwd);
  if (!isPaseoWorktreePath(resolved, paseoHome(env)) || resolved === path.resolve(root)) return undefined;
  const rel = resolved.slice(path.resolve(root).length + 1).split(path.sep).filter(Boolean);
  const slug = rel[1] ?? rel[0]; // <hash>/<slug>
  if (!slug) return undefined;
  return { labelFull: slug, source: 'worktree' };
}

/**
 * Resolve the workspace label for `cwd`.
 *
 * @param cwd     the cwd the tool call belongs to (ctx.cwd — not process.cwd).
 * @param env     environment to read PASEO_* from (defaults to process.env).
 * @param maxLen  label budget; the untruncated form stays in `labelFull`.
 */
export function resolveWorkspace(
  cwd: string,
  env: WorkspaceEnv = process.env as WorkspaceEnv,
  maxLen: number = DEFAULT_LABEL_MAX_LEN,
): WorkspaceInfo {
  const target = text(cwd) ?? process.cwd();
  let info: Omit<WorkspaceInfo, 'label'>;
  try {
    info = fromPaseo(target, env)
      ?? fromWorktreePath(target, env)
      ?? { labelFull: path.basename(path.resolve(target)) || target, source: 'path' };
  } catch {
    // Fail-safe: notifications must never depend on this resolving.
    info = { labelFull: path.basename(path.resolve(target)) || target, source: 'path' };
  }
  return { ...info, label: clamp(info.labelFull, maxLen) };
}

/** Convenience wrapper when only the display label is needed. */
export function resolveWorkspaceLabel(
  cwd: string,
  env: WorkspaceEnv = process.env as WorkspaceEnv,
  maxLen: number = DEFAULT_LABEL_MAX_LEN,
): string {
  return resolveWorkspace(cwd, env, maxLen).label;
}
