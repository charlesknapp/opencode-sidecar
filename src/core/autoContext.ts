// Editor context that follows the editor (`opencodeSidecar.autoContext`, off by default).
// Only the active editor counts, never other open tabs: its selection, or the whole file
// when nothing is selected. It shows as a chip the user can remove; a removed chip stays
// away until the editor shows another file or selection. What is sent is what the chip
// shows at send time.

import type { ContextAttachment } from "../shared/model";
import { validateSelection } from "./context";

type Editable = Extract<ContextAttachment, { kind: "file" | "selection" }>;

/** The active editor, as the host reads it. `relPath` is null outside the open folder. */
export interface EditorSnapshot {
  absPath: string;
  relPath: string | null;
  languageId: string;
  /** The selection (1-based lines), absent when it is empty. */
  selection?: { startLine: number; endLine: number; text: string };
  /** The file looks sensitive (src/core/sensitive.ts); it is never attached by itself. */
  sensitive: boolean;
}

/** Which file or lines the chip stands for; a removed chip is remembered by this. */
export function autoKey(s: EditorSnapshot): string {
  const sel = s.selection && !validateSelection(s.selection.text) ? s.selection : undefined;
  return sel ? `${s.absPath}#${sel.startLine}-${sel.endLine}` : s.absPath;
}

/**
 * The attachment the editor stands for, or null: none open, a file outside the folder
 * or a sensitive one, the chip removed for this file or selection, or the same file or
 * lines already attached by hand. An empty, blank or too large selection means the file.
 */
export function autoAttachment(
  s: EditorSnapshot | null,
  dismissed: string | null,
  explicit: readonly ContextAttachment[],
): Editable | null {
  if (!s || !s.relPath || s.sensitive) return null;
  const key = autoKey(s);
  if (key === dismissed) return null;
  const sel = s.selection && !validateSelection(s.selection.text) ? s.selection : undefined;
  const id = `auto:${key}`;
  if (!sel) {
    if (explicit.some((a) => a.kind === "file" && a.absPath === s.absPath)) return null;
    return { kind: "file", id, relPath: s.relPath, absPath: s.absPath };
  }
  const same = explicit.some(
    (a) =>
      (a.kind === "file" && a.absPath === s.absPath) ||
      (a.kind === "selection" &&
        a.absPath === s.absPath &&
        a.startLine === sel.startLine &&
        a.endLine === sel.endLine),
  );
  if (same) return null;
  return {
    kind: "selection",
    id,
    relPath: s.relPath,
    absPath: s.absPath,
    startLine: sel.startLine,
    endLine: sel.endLine,
    text: sel.text,
    languageId: s.languageId,
  };
}

/** True for the chip id of the editor context (removing it dismisses it, see above). */
export function isAutoId(id: string): boolean {
  return id.startsWith("auto:");
}
