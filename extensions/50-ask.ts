// ============================================================
// Extension entry: Ask — the ask_user_question tool (tabbed
// structured questions, multi-select, Markdown previews, Chat
// exit). The dialog component itself (ask/dialog.ts) is shared
// with the permission approval panel and stays importable even
// when this entry is filtered out.
//
// Filter out this file to drop the interactive-question tool.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestion } from "../ask/index";

export default function (pi: ExtensionAPI) {
  registerAskUserQuestion(pi);
}
