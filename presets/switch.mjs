#!/usr/bin/env node
// ============================================================
// presets/switch.mjs — switch the active pi package set (preset).
//
// Usage:
//   node presets/switch.mjs                    list presets + current state
//   node presets/switch.mjs <preset>           switch packages to preset
//   node presets/switch.mjs diff <preset>      preview changes, modify nothing
//   node presets/switch.mjs full               restore latest full snapshot
//
// What it does (switch mode):
//   1. Backs up ~/.pi/agent/settings.json (timestamped, never overwritten)
//   2. Atomically replaces ONLY the `packages` array from the preset
//      (theme/defaultModel/everything else untouched)
//   3. Sidelines loose global decorations into ~/.pi/agent/disabled/
//      (extensions/image2.ts, skills/joyspace-md-import — now shipped by
//      the personal/ package; loose copies would double-register)
//   4. Prints the before/after diff + restart reminder
//
// Rollback: restore the latest ~/.pi/agent/settings.json.bak-* manually,
// or switch back: node presets/switch.mjs full
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = __dirname;
const SETTINGS = path.join(homedir(), ".pi", "agent", "settings.json");
const AGENT_DIR = path.join(homedir(), ".pi", "agent");
const DISABLED_DIR = path.join(AGENT_DIR, "disabled");

// Loose decorations superseded by the personal/ package (see personal/README.md).
const LOOSE_DECORATIONS = [
  { from: path.join(AGENT_DIR, "extensions", "image2.ts"), toDir: path.join(DISABLED_DIR, "extensions") },
  { from: path.join(AGENT_DIR, "skills", "joyspace-md-import"), toDir: path.join(DISABLED_DIR, "skills") },
];

function loadPresets() {
  const files = readdirSync(PRESETS_DIR).filter(f => f.endsWith(".json"));
  const presets = new Map();
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(path.join(PRESETS_DIR, f), "utf8"));
      if (Array.isArray(d?.packages)) presets.set(d.name ?? f.replace(/\.json$/, ""), { file: f, data: d });
    } catch { /* skip malformed */ }
  }
  return presets;
}

function resolvePreset(arg, presets) {
  if (presets.has(arg)) return presets.get(arg);
  // "full" resolves to the newest full.snapshot.*.json
  if (arg === "full") {
    const snaps = [...presets.entries()]
      .filter(([n]) => n.startsWith("full.snapshot"))
      .sort((a, b) => b[0].localeCompare(a[0]));
    if (snaps.length > 0) return snaps[0][1];
  }
  return undefined;
}

function describeEntry(e) {
  if (typeof e === "string") return e;
  const src = e.source ?? "(no source)";
  const parts = [];
  for (const k of ["extensions", "skills", "prompts", "themes"]) {
    if (Array.isArray(e[k])) parts.push(`${k}[${e[k].length}]`);
  }
  return `${src} (${parts.join(" ")})`;
}

function readSettings() {
  const raw = readFileSync(SETTINGS, "utf8");
  const d = JSON.parse(raw);
  if (!Array.isArray(d.packages)) throw new Error("settings.json has no packages array — refusing to touch it");
  return d;
}

function writeSettingsAtomic(data) {
  const tmp = SETTINGS + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, SETTINGS);
}

function sidelineLooseDecorations() {
  const moved = [];
  for (const { from, toDir } of LOOSE_DECORATIONS) {
    if (!existsSync(from)) continue;
    mkdirSync(toDir, { recursive: true });
    renameSync(from, path.join(toDir, path.basename(from)));
    moved.push(path.relative(AGENT_DIR, from) + " → disabled/");
  }
  return moved;
}

function diffPackages(before, after) {
  const b = new Set(before.map(describeEntry));
  const a = new Set(after.map(describeEntry));
  const removed = [...b].filter(x => !a.has(x));
  const added = [...a].filter(x => !b.has(x));
  return { removed, added };
}

// ── main ──
const [cmd, ...rest] = process.argv.slice(2);
const presets = loadPresets();

if (!cmd || cmd === "list") {
  console.log("Available presets (presets/*.json):");
  for (const [name, p] of presets) console.log(`  ${name.padEnd(24)} ${p.file}`);
  try {
    const cur = readSettings();
    console.log(`\nCurrent settings: ${cur.packages.length} package entries:`);
    for (const e of cur.packages) console.log(`  - ${describeEntry(e)}`);
  } catch (e) {
    console.log(`\nCannot read settings: ${e.message}`);
  }
  console.log("\nUsage: node presets/switch.mjs <preset> | diff <preset> | list");
  process.exit(0);
}

const isDiff = cmd === "diff";
const presetName = isDiff ? rest[0] : cmd;
const preset = resolvePreset(presetName, presets);
if (!preset) {
  console.error(`Preset not found: ${presetName}`);
  console.error("Available: " + [...presets.keys()].join(", "));
  process.exit(1);
}

let settings;
try {
  settings = readSettings();
} catch (e) {
  console.error(`Aborting: ${e.message}`);
  process.exit(1);
}

const { removed, added } = diffPackages(settings.packages, preset.data.packages);

console.log(`Preset: ${preset.data.name} (${preset.file})`);
console.log("\nRemoved from active set:");
for (const r of removed.length ? removed : ["(none)"]) console.log(`  - ${r}`);
console.log("\nAdded to active set:");
for (const a of added.length ? added : ["(none)"]) console.log(`  + ${a}`);

if (isDiff) {
  console.log("\n(diff mode — settings.json not modified)");
  process.exit(0);
}

// 1. Backup (timestamped, never overwritten)
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${SETTINGS}.bak-${stamp}`;
writeFileSync(backup, readFileSync(SETTINGS, "utf8"), "utf8");
console.log(`\nBackup: ${path.basename(backup)}`);

// 2. Replace packages array only (atomic)
settings.packages = preset.data.packages;
writeSettingsAtomic(settings);
console.log("settings.json updated (packages array replaced; all other keys preserved).");

// 3. Sideline loose decorations
const moved = sidelineLooseDecorations();
if (moved.length) console.log("Sidelined loose copies (now shipped via personal/ package):");
for (const m of moved) console.log(`  ~ ${m}`);

console.log("\nDone. Restart pi for the change to take effect.");
console.log("Rollback: restore the .bak file above, or: node presets/switch.mjs full");
