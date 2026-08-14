// Builds the GitHub Release body from the tagged version's CHANGELOG.md
// section. Fails loudly when the section is missing, so a release can never
// ship with an empty "What's new" again.
//
// Usage: RELEASE_TAG=v0.9.18 node .github/scripts/release-body.mjs
// Prints the full markdown body to stdout.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = process.env.RELEASE_TAG ?? process.argv[2];
if (!tag) throw new Error("RELEASE_TAG (or argv[2]) required, e.g. v0.9.18");
const version = tag.replace(/^v/, "");

const changelog = readFileSync(resolve(process.cwd(), "CHANGELOG.md"), "utf8");
// Split-based section extraction: a regex with \z is a JS pitfall (\z is not
// a valid escape and falls back to the literal character 'z', truncating any
// section whose text contains a z — e.g. "Freeze"). Line scan is immune.
const lines = changelog.split("\n");
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i] === `## ${version}`) {
    start = i + 1;
    break;
  }
}
if (start < 0) throw new Error(`No "## ${version}" section in CHANGELOG.md`);
let end = lines.length;
for (let i = start; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}
const section = lines.slice(start, end).join("\n").trim();
if (!section) throw new Error(`No "## ${version}" section in CHANGELOG.md`);

process.stdout.write(`## What's new in ${version}

${section}

## Install

\`\`\`bash
pi install npm:pi-lamboy-harness
npm install pi-lamboy-harness@${version}
\`\`\`

## Compatibility

- pi 0.81.x–0.83.x
- Node 24/26
`);
