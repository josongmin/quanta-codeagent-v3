/**
 * RFC-11 / ADR-0446 — external `$EDITOR` composition port (ctrl-x ctrl-e).
 *
 * A THIN, closed port the raw-line reader is injected with. It REUSES the
 * already-safe, already-tested editor driver from `edit-plan-cmd.ts`
 * (`resolveEditor` / `defaultEditorSpawn` / `editInTemp`, ADR-0225) — NO new
 * spawn code is written here. The driver writes the draft to a tmpdir file,
 * spawns `$EDITOR <path>` (stdio inherit), reads it back, and returns a typed
 * result; every failure mode (spawn / nonzero-exit / fs) is a typed value, so
 * `openDraft` NEVER throws — a failed edit degrades to a no-op (the original
 * draft is returned unchanged) and the reason is reported via `onWarn`.
 *
 * The raw-mode suspend/restore around the spawn is the READER's job (it owns
 * the TTY); this port is pure of the terminal and pure of the reader's state.
 *
 * Slice posture: imports only `./edit-plan-cmd` (already-public driver) and
 * `node:*` transitively through it. No `@/agent`, no `@/permission`.
 */

import { defaultEditorSpawn, editInTemp, resolveEditor } from "./edit-plan-cmd"

export interface OpenDraftResult {
  readonly text: string
  readonly changed: boolean
}

/** Closed port: open the current draft in `$EDITOR`, return the edited text.
 *  Implementations MUST NOT throw — a failed/cancelled edit returns the input
 *  text with `changed: false`. */
export interface ExternalEditorPort {
  openDraft(text: string): Promise<OpenDraftResult>
}

export interface BuildExternalEditorArgs {
  /** Test/explicit override — pins the editor command verbatim, bypassing
   *  `$VISUAL`/`$EDITOR` discovery. */
  readonly editorOverride?: string
  /** Env reader. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Spawn impl. Resolves with the editor's exit code (127 ⇒ spawn failure).
   *  Default `defaultEditorSpawn` (stdio inherit). */
  readonly spawn?: (cmd: string, args: readonly string[]) => Promise<number>
  /** Single-line failure reporter (stderr in production). */
  readonly onWarn?: (line: string) => void
}

export const buildExternalEditor = (a: BuildExternalEditorArgs = {}): ExternalEditorPort => ({
  async openDraft(text: string): Promise<OpenDraftResult> {
    const editor = resolveEditor(a.editorOverride, a.env ?? process.env)
    const spawn = a.spawn ?? defaultEditorSpawn
    const res = await editInTemp({ body: text, suffix: "draft.md", editor, spawn })
    if (res.kind === "ok") return { text: res.text, changed: res.changed }
    // Every failure ⇒ no-op: keep the original draft, report the reason.
    if (res.kind === "spawn_failed") {
      a.onWarn?.(`editor not found: ${res.cmd} (set $EDITOR or install vi)`)
    } else if (res.kind === "editor_failed") {
      a.onWarn?.(`editor exited with code ${res.code} — draft unchanged`)
    } else {
      a.onWarn?.(`${res.stage} failed: ${res.message} — draft unchanged`)
    }
    return { text, changed: false }
  },
})
