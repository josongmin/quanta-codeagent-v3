/**
 * `/edit-message` (ADR-0225 — Claude Code `tengu_external_editor`
 * absorption, composer leg).
 *
 * Open the pending composer text in `$EDITOR` for editing before send.
 * The surface owns the composer state (raw-line-reader buffer in CLI; a
 * future Tauri shell has its own controlled `<textarea>`); we duck-type
 * a tiny `ComposerEditPort` so the slash never imports `apps/cli/repl.ts`
 * or `apps/cli/raw-line-reader.ts`.
 *
 * Default-OFF: `ctx.composerEdit` absent ⇒ "not wired in this surface" +
 * exit 0.
 *
 * Slice posture (RFC §3.1):
 *   - Lives in `apps/cli`. Re-uses the editor-discovery + `editInTemp`
 *     helpers from `./edit-plan-cmd` (sibling, same slice) so the temp
 *     file lifecycle + editor spawn matches byte-for-byte.
 *   - exactOptionalPropertyTypes-clean.
 *   - No-throw on the public surface.
 *
 * The 4 SlashContext seams `editorOverride` / `editorEnv` / `editorSpawn`
 * are SHARED with `/edit-plan` — pinning them for one slash pins both.
 * That is intentional: a test that overrides `$EDITOR` to a fake should
 * see the override for every external-editor surface.
 */

import { errMessage } from "@/shared"
import { defaultEditorSpawn, editInTemp, renderEditResult, resolveEditor } from "./edit-plan-cmd"
import type { SlashCommand } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

// The `ComposerEditPort` CONTRACT lives in `@/agent/surface-ports` (the agent
// core owns it; this surface implements + wires it). Re-exported here so the
// existing `./edit-message-cmd` importers (slash-surface, composer-edit-adapter)
// are unaffected.
export type { ComposerEditPort } from "@/agent/surface-ports"

import type { ComposerEditPort } from "@/agent/surface-ports"

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0225 composer-edit wire. Absent ⇒ "not wired in this surface". */
    readonly composerEdit?: ComposerEditPort | undefined
  }
}

/* ------------------------------------------------------------------ */
/* command                                                              */
/* ------------------------------------------------------------------ */

export const editMessageCmd: SlashCommand = {
  name: "/edit-message",
  describe: "Open the pending composer text in $EDITOR before sending",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err(`/edit-message: takes no arguments; got ${args.length}\n`)
      return 1
    }
    if (ctx.composerEdit === undefined) {
      ctx.out("/edit-message: not wired in this surface\n")
      return 0
    }
    let pending: string
    try {
      const v = ctx.composerEdit.getPending()
      pending = v instanceof Promise ? await v : v
    } catch (e) {
      ctx.err(`/edit-message: getPending failed: ${errMessage(e)}\n`)
      return 1
    }
    const editor = resolveEditor(ctx.editorOverride, ctx.editorEnv ?? process.env)
    const spawnFn = ctx.editorSpawn ?? defaultEditorSpawn
    const res = await editInTemp({
      body: pending,
      suffix: "msg.md",
      editor,
      spawn: spawnFn,
    })
    const rendered = renderEditResult(res, "/edit-message", ctx.out, ctx.err)
    if (rendered !== null) return rendered.exit
    if (res.kind !== "ok") return 1
    try {
      const r = ctx.composerEdit.setPending(res.text)
      if (r instanceof Promise) await r
    } catch (e) {
      ctx.err(`/edit-message: setPending failed: ${errMessage(e)}\n`)
      return 1
    }
    ctx.out(`/edit-message: updated (${res.text.length} chars) — press Enter to send\n`)
    return 0
  },
}
