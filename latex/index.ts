// ============================================================
// Latex toolchain (adapter, pi extension).
//
// Registers two tools and one command:
//   - latex_compile : tectonic backend with structured file:line errors
//   - bibtex_check  : citation/bib cross-consistency (3 issue kinds)
//   - /compile      : human shortcut (resolves the single .tex in cwd)
//
// Permission gating: these are ordinary pi tools, so every invocation is
// gated by the harness permission policy chain before this code runs; the
// tectonic subprocess spawned here never bypasses that chain.
//
// Requires tectonic on PATH (brew install tectonic). A missing binary yields
// a structured "not found" error instead of a crash.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { parseTectonicLog } from "../packages/core/latex/parse-log";
import { checkBib } from "../packages/core/latex/bib-check";
import type { BibIssue, CompileResult } from "../packages/core/latex/types";

// ── tectonic execution (injectable for tests) ─────────────────

export type ExecResult = { stdout: string; stderr: string; code: number };
export type ExecTectonic = (argv: string[], cwd?: string) => Promise<ExecResult>;

async function defaultExecTectonic(argv: string[], cwd?: string): Promise<ExecResult> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    // ENOENT (tectonic missing) surfaces as an 'error' event before 'close'.
    child.on("error", (err) => resolve({ stdout, stderr: String(err), code: 1 }));
  });
}

let execTectonicImpl: ExecTectonic = defaultExecTectonic;

/** Test injection point: replace the tectonic executor; pass null to restore. */
export function __setExecForTest(fn: ExecTectonic | null): void {
  execTectonicImpl = fn ?? defaultExecTectonic;
}

function execTectonic(argv: string[], cwd?: string): Promise<ExecResult> {
  return execTectonicImpl(argv, cwd);
}

// ── shared implementation (used by tools and *ForTest surfaces) ──

function formatCompileMarkdown(r: CompileResult, texFile: string): string {
  if (r.ok) {
    return [
      "## latex_compile",
      `- ✅ compiled ${path.basename(texFile)}`,
      `- pdf: ${r.pdfPath}`,
    ].join("\n");
  }
  const lines = [
    "## latex_compile",
    `- ❌ failed to compile ${path.basename(texFile)}`,
    "",
    "| severity | file | line | message | hint |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const e of r.errors) {
    lines.push(`| ${e.severity} | ${e.file} | ${e.line} | ${e.message} | ${e.hint ?? ""} |`);
  }
  return lines.join("\n");
}

export interface CompileOutcome extends CompileResult {
  markdown: string;
}

async function runCompile(texFile: string, args: string[]): Promise<CompileOutcome> {
  const abs = path.resolve(texFile);
  const dir = path.dirname(abs);
  const base = path.basename(abs, path.extname(abs));
  const argv = ["tectonic", ...(args ?? []), abs];

  const res = await execTectonic(argv, dir);

  // Missing binary: shell exit 127 or an ENOENT-style spawn error.
  if (res.code === 127 || /ENOENT/i.test(res.stderr)) {
    const result: CompileResult = {
      ok: false,
      errors: [
        {
          file: "",
          line: 0,
          severity: "error",
          message: "tectonic not found — install it with: brew install tectonic",
          hint: "brew install tectonic",
        },
      ],
      rawTail: res.stderr || "tectonic not found",
    };
    return { ...result, markdown: formatCompileMarkdown(result, abs) };
  }

  const parsed = parseTectonicLog(`${res.stdout}\n${res.stderr}`);
  const ok = parsed.ok && res.code === 0;
  const result: CompileResult = {
    ok,
    pdfPath: ok ? path.join(dir, `${base}.pdf`) : undefined,
    errors: parsed.errors,
    rawTail: parsed.rawTail,
  };
  return { ...result, markdown: formatCompileMarkdown(result, abs) };
}

function formatBibMarkdown(issues: BibIssue[], bibFile: string): string {
  if (issues.length === 0) {
    return `## bibtex_check\n- ✅ ${path.basename(bibFile)}: no consistency issues`;
  }
  const lines = [
    "## bibtex_check",
    `- ${issues.length} issue(s) in ${path.basename(bibFile)}`,
    "",
  ];
  for (const i of issues) {
    lines.push(`- ${i.kind}: ${i.detail}`);
  }
  return lines.join("\n");
}

export interface BibOutcome {
  issues: BibIssue[];
  markdown: string;
}

async function runBibCheck(texFile: string, bibFile?: string): Promise<BibOutcome> {
  const abs = path.resolve(texFile);
  const dir = path.dirname(abs);
  const bibAbs = bibFile
    ? path.resolve(bibFile)
    : path.join(dir, path.basename(abs, path.extname(abs)) + ".bib");

  if (!fs.existsSync(abs)) {
    throw new Error(`bibtex_check: tex file not found: ${abs}`);
  }
  if (!fs.existsSync(bibAbs)) {
    throw new Error(`bibtex_check: bib file not found: ${bibAbs} (pass bibFile or place <name>.bib next to the tex)`);
  }

  const texSource = fs.readFileSync(abs, "utf8");
  const bibSource = fs.readFileSync(bibAbs, "utf8");
  const { issues } = checkBib(texSource, bibSource);
  return { issues, markdown: formatBibMarkdown(issues, bibAbs) };
}

// ── /compile argument resolution ──────────────────────────────

function resolveTexFile(provided: string | undefined, cwd: string): string {
  if (provided && provided.trim()) return path.resolve(provided.trim());
  const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".tex"));
  if (files.length === 1) return path.join(cwd, files[0]);
  if (files.length === 0) {
    throw new Error(`/compile: no .tex file in ${cwd} — pass an explicit path`);
  }
  throw new Error(`/compile: ambiguous — multiple .tex files in ${cwd} (${files.join(", ")}) — pass an explicit path`);
}

// ── *ForTest surfaces (same implementation path as the tools) ──

export async function compileForTest(texFile: string, args: string[] = []): Promise<CompileOutcome> {
  return runCompile(texFile, args);
}

export async function bibCheckForTest(texFile: string, bibFile?: string): Promise<BibOutcome> {
  return runBibCheck(texFile, bibFile);
}

// ── tool + command registration ──────────────────────────────

export function registerLatexTools(pi: any): void {
  pi.registerTool({
    name: "latex_compile",
    label: "LaTeX Compile",
    promptSnippet: "latex_compile: compile a .tex file with tectonic and return structured file:line errors with fix hints",
    promptGuidelines: [
      "Use this to compile any .tex file locally; it reports structured errors (file:line:severity + fix hint) instead of a raw log",
      "texFile must be an absolute path; args are optional extra tectonic flags (e.g. ['--outdir', '/tmp/x'])",
      "Requires tectonic on PATH (brew install tectonic); the tool returns a friendly error if it is missing",
      "bibtex_check is the companion for citation/bib consistency (undefined-citation / unused-entry / duplicate-key)",
    ],
    parameters: {
      type: "object",
      properties: {
        texFile: { type: "string", description: "absolute path to the .tex file" },
        args: { type: "array", items: { type: "string" }, description: "optional extra tectonic flags" },
      },
      required: ["texFile"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      try {
        const out = await runCompile(String(params?.texFile ?? ""), Array.isArray(params?.args) ? params.args : []);
        return { content: [{ type: "text", text: out.markdown, details: { ok: out.ok, pdfPath: out.pdfPath, errors: out.errors } }] };
      } catch (e) {
        return { content: [{ type: "text", text: `latex_compile failed: ${String(e)}` }] };
      }
    },
  });

  pi.registerTool({
    name: "bibtex_check",
    label: "BibTeX Check",
    promptSnippet: "bibtex_check: cross-check a .tex source against its .bib for undefined-citation / unused-entry / duplicate-key",
    promptGuidelines: [
      "Use this to find citation/bibliography consistency issues before submitting a paper",
      "texFile is the absolute path to the .tex; bibFile defaults to <name>.bib next to the tex",
      "Reports three issue kinds: undefined-citation (\\cite with no @entry), unused-entry (@entry never cited), duplicate-key (same key twice)",
      "This is a pure text cross-check — it does not validate metadata (use pi-bib for CrossRef/Semantic Scholar checks)",
    ],
    parameters: {
      type: "object",
      properties: {
        texFile: { type: "string", description: "absolute path to the .tex file" },
        bibFile: { type: "string", description: "absolute path to the .bib file (default: <name>.bib next to texFile)" },
      },
      required: ["texFile"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      try {
        const out = await runBibCheck(String(params?.texFile ?? ""), params?.bibFile ? String(params.bibFile) : undefined);
        return { content: [{ type: "text", text: out.markdown, details: { issues: out.issues } }] };
      } catch (e) {
        return { content: [{ type: "text", text: `bibtex_check failed: ${String(e)}` }] };
      }
    },
  });

  pi.registerCommand("compile", {
    description: "Compile a LaTeX file with tectonic (no argument = the single .tex in cwd)",
    usage: [
      "/compile                 Compile the single .tex in cwd",
      "/compile <file.tex>      Compile a specific .tex file",
    ].join("\n"),
    handler: async (args: string, ctx: any) => {
      const cwd = ctx?.cwd || process.cwd();
      try {
        const texFile = resolveTexFile(args || undefined, cwd);
        const out = await runCompile(texFile, []);
        const summary = out.ok
          ? `compiled ${path.basename(texFile)} → ${out.pdfPath}`
          : `compile failed: ${out.errors[0]?.message ?? "unknown error"}`;
        try { ctx.ui.notify(summary, out.ok ? "success" : "error"); } catch { /* ok */ }
        try { ctx.showStatus?.(summary); } catch { /* ok */ }
      } catch (e) {
        const msg = String(e);
        try { ctx.ui.notify(msg, "error"); } catch { /* ok */ }
        try { ctx.showStatus?.(msg); } catch { /* ok */ }
      }
    },
  });
}
