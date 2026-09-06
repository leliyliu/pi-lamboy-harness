// ============================================================
// Extension entry: Latex toolchain — latex_compile (tectonic
// backend, structured file:line errors + fix hints), bibtex_check
// (undefined-citation / unused-entry / duplicate-key), /compile
// command. Requires tectonic (brew install tectonic); returns a
// friendly error when missing.
//
// Filter out this file to drop LaTeX tooling outside paper
// projects (metadata validation belongs to pi-bib; this is the
// compile + citation-consistency side).
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLatexTools } from "../latex/index";

export default function (pi: ExtensionAPI) {
  registerLatexTools(pi);
}
