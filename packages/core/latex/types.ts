// latex-toolchain core types — pure, no host imports.
export interface LatexError {
  file: string;
  line: number;
  col?: number;
  severity: "error" | "warning";
  message: string;
  hint?: string;
}

export interface CompileResult {
  ok: boolean;
  pdfPath?: string;
  errors: LatexError[];
  rawTail: string;
}

export interface BibIssue {
  kind: "undefined-citation" | "unused-entry" | "duplicate-key";
  detail: string;
}
