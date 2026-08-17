// latex-toolchain BibTeX consistency checker — pure, no host imports.
//
// Cross-checks a .tex source against a .bib source for the three consistency
// issue kinds the harness surfaces:
//   - duplicate-key        : the same key declared more than once in the .bib
//   - undefined-citation   : \cite{key} with no matching @entry in the .bib
//   - unused-entry         : @entry in the .bib never \cite'd from the source
//
// Also extracts \ref/\label keys (pure text scan) and surfaces them on the
// result so the adapter layer can build on them without re-parsing; no
// "undefined-reference" issue kind exists in the current type set.
import type { BibIssue } from "./types.ts";

export interface BibCheckResult {
  issues: BibIssue[];
  /** \cite keys seen in the tex source. */
  cited: Set<string>;
  /** \ref keys seen in the tex source. */
  refs: Set<string>;
  /** \label keys declared in the tex source. */
  labels: Set<string>;
}

const CITE_RE = /\\cite\s*\{([^}]*)\}/g;
const REF_RE = /\\ref\s*\{([^}]*)\}/g;
const LABEL_RE = /\\label\s*\{([^}]*)\}/g;
const BIB_ENTRY_RE = /^\s*@\w+\{([^,\s]+)\s*,/;

function splitKeys(body: string): string[] {
  return body.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
}

/** Collect comma-expanded keys for a given regex over the source. */
function collectKeys(source: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(source)) !== null) {
    for (const k of splitKeys(m[1])) out.add(k);
  }
  return out;
}

export function checkBib(texSource: string, bibSource: string): BibCheckResult {
  const issues: BibIssue[] = [];

  // Parse .bib entries: line-start "@type{key," — declaration order matters
  // for duplicate detection, so keep both the ordered list and the seen set.
  const bibKeys: string[] = [];
  const seen = new Set<string>();
  for (const line of bibSource.split("\n")) {
    const m = BIB_ENTRY_RE.exec(line);
    if (!m) continue;
    const key = m[1];
    bibKeys.push(key);
    if (seen.has(key)) {
      issues.push({ kind: "duplicate-key", detail: key });
    } else {
      seen.add(key);
    }
  }

  const cited = collectKeys(texSource, CITE_RE);
  const refs = collectKeys(texSource, REF_RE);
  const labels = collectKeys(texSource, LABEL_RE);

  // cite − bib = undefined-citation
  for (const key of cited) {
    if (!seen.has(key)) {
      issues.push({ kind: "undefined-citation", detail: key });
    }
  }

  // bib − cite = unused-entry
  for (const key of bibKeys) {
    if (!cited.has(key)) {
      issues.push({ kind: "unused-entry", detail: key });
    }
  }

  return { issues, cited, refs, labels };
}
