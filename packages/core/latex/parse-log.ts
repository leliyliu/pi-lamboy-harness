// latex-toolchain log parser — pure, no host imports.
//
// Parses tectonic (XeTeX engine) console output into structured errors.
// Real tectonic 0.17.0 format (calibrated 2026-08-14):
//
//   error: main.tex:12: Missing $ inserted
//   error: something bad happened inside XeTeX; its output follows:
//   error: the XeTeX engine had an unrecoverable error
//   caused by: halted on potentially-recoverable error as specified
//
// Errors/warnings are single-line: "<severity>: <file>:<line>: <message>".
// Engine chatter lines (no file:line) are filtered out of `errors` but kept
// in `rawTail` so the model still sees the full context.
import type { LatexError } from "./types";

const ERROR_LINE_RE = /^(error|warning):\s*([^:]+):(\d+):\s*(.*)$/;

// No-file:line engine chatter that must never become a structured error.
const NOISE_MARKERS = [
  /something bad happened inside XeTeX/i,
  /the XeTeX engine had an unrecoverable error/i,
];

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Best-effort fix hints keyed on message text.
function hintFor(message: string): string | undefined {
  if (/undefined (reference|citation)/i.test(message)) {
    return "Rerun compile (refs need 2 passes) or check the key";
  }
  if (/missing \$/i.test(message)) {
    return "Check math-mode delimiters around the reported line";
  }
  if (/undefined control sequence/i.test(message)) {
    return "Check the macro name / add the package";
  }
  return undefined;
}

export function parseTectonicLog(stdout: string): {
  ok: boolean;
  errors: LatexError[];
  rawTail: string;
} {
  const lines = (stdout || "").split(/\r?\n/);
  const errors: LatexError[] = [];
  let sawEngineFailure = false;

  for (const line of lines) {
    // Engine chatter (no file:line) must be detected BEFORE the regex gate:
    // otherwise a pure engine failure yields zero structured errors and `ok`
    // would incorrectly report true.
    if (NOISE_MARKERS.some((re) => re.test(line))) {
      sawEngineFailure = true;
      continue;
    }

    const m = ERROR_LINE_RE.exec(line);
    if (!m) continue;
    const severity = m[1] as "error" | "warning";
    const file = basename(m[2]);
    const lineNo = Number(m[3]);
    const message = m[4];

    errors.push({
      file,
      line: lineNo,
      severity,
      message,
      hint: hintFor(message),
    });
  }

  const rawTail = lines.slice(-30).join("\n");
  return { ok: errors.every((e) => e.severity !== "error") && !sawEngineFailure, errors, rawTail };
}
