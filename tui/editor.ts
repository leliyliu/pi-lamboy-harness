// ============================================================
// TUI — LamboyEditor: custom pi editor with switchable chrome.
//
//   boxed   — closed box (╭╮│╰╯) with spinner/model
//             embedded in the top border.
//   compact — pi-spark-style: plain side-less editor, top border carries
//             spinner left + model right.
//   plain   — not handled here: the runtime unregisters the custom
//             editor entirely and pi's default editor comes back.
//
// Editor instances are immutable w.r.t. style: switching styles
// re-registers the factory via ctx.ui.setEditorComponent, and pi
// hot-swaps the editor (preserving text, focus, autocomplete and
// keybinding handlers — see pi's setCustomEditorComponent).
// ============================================================

import { CustomEditor } from "@earendil-works/pi-coding-agent";

import { composeTopBorder, wrapWithSideBorders, type EditorStyle } from "../packages/core/tui/box";
import type { RenderTiming } from "../packages/core/tui/timing";

import type { TUI, EditorTheme } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

/** Pre-styled border slots, evaluated per render (cheap string joins only). */
export interface EditorSlots {
  left(): string;
  right(): string;
}

export class LamboyEditor extends CustomEditor {
  private readonly chromeStyle: EditorStyle;
  private readonly slots: EditorSlots;
  private readonly timing: RenderTiming | null;
  private readonly onRender: (() => void) | null;
  private autocompleteWasShowing = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    style: EditorStyle,
    slots: EditorSlots,
    timing: RenderTiming | null = null,
    onRender: (() => void) | null = null,
  ) {
    // boxed needs column 0 reserved for the left │ bar, plus at least one
    // space of breathing room between the bar and the text/cursor:
    // pi-tui pads rows with spaces up to paddingX; wrapWithSideBorders
    // replaces the outer padding columns with │, so paddingX=1 would render
    // "│<text>│" with the cursor touching the border. paddingX=2 yields
    // "│ <text> │".
    super(tui, theme, keybindings, { paddingX: style === "boxed" ? 2 : 0 });
    this.chromeStyle = style;
    this.slots = slots;
    this.timing = timing;
    this.onRender = onRender;
  }

  /**
   * pi copies the default editor's paddingX into custom editors right
   * after construction (setCustomEditorComponent). Enforce the boxed
   * minimum of 2 so the │ bars never touch the text/cursor.
   */
  override setPaddingX(padding: number): void {
    super.setPaddingX(this.chromeStyle === "boxed" ? Math.max(2, padding) : padding);
  }

  /**
   * Detect an autocomplete open→close edge from a render frame and force a
   * full re-render so the editor snaps back to the bottom instead of
   * sitting where the taller dropdown left it (custom-editor.ts:261
   * parity). Running from render() also catches asynchronous closes — e.g.
   * Backspace deleting the leading `/`, where pi-tui only cancels the menu
   * once the provider re-query resolves.
   */
  private trackAutocompleteCloseForFullRender(): void {
    const showing = (this as any).isShowingAutocomplete?.() ?? false;
    const closed = this.autocompleteWasShowing && !showing;
    this.autocompleteWasShowing = showing;
    if (closed) {
      // Deferred so the overflow probe below does not re-enter render()
      // synchronously.
      queueMicrotask(() => this.requestFullRenderOnAutocompleteClose());
    }
  }

  private requestFullRenderOnAutocompleteClose(): void {
    if (process.env.TMUX) return; // tmux reflows the shrink itself
    const { columns, rows } = this.tui.terminal;
    // Redraw only when content fills or overflows the viewport; below that
    // a full clear would pull the editor up and leave a blank tail.
    if (this.tui.render(columns).length < rows) return;
    this.tui.requestRender(true);
  }

  override render(width: number): string[] {
    this.onRender?.();
    this.trackAutocompleteCloseForFullRender();
    const t0 = this.timing ? performance.now() : 0;
    const lines = super.render(width);
    let out = lines;
    if (lines.length > 0) {
      const paint = (s: string) => this.borderColor(s);
      if (this.chromeStyle === "compact") {
        out = [...lines];
        out[0] = composeTopBorder(width, this.slots.left(), this.slots.right(), paint, false);
      } else if (this.chromeStyle === "boxed") {
        // First content line gets a prompt chevron in the inner padding
        // column (the left │ bar occupies column 0 after wrapping). The
        // chevron sits in the padding space, so text and cursor position
        // are unaffected — it reads like a shell prompt: │❯ text │
        const decorated = [...lines];
        const contentLine = decorated[1];
        if (contentLine && contentLine.length > 1 && contentLine[1] === " ") {
          decorated[1] = contentLine.slice(0, 1) + paint("\u276F") + contentLine.slice(2);
        }
        out = wrapWithSideBorders(decorated, paint, {
          topBorder: composeTopBorder(width, this.slots.left(), this.slots.right(), paint, true),
        });
      }
    }
    if (this.timing) this.timing.record("editor", performance.now() - t0);
    return out;
  }
}
