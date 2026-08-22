/**
 * `/edit-plan` (ADR-0225 — Claude Code `tengu_external_editor` absorption).
 *
 * Open the current plan in `$EDITOR` (defaulting to `vi`), let the user
 * make mid-execution edits, then push the edited text back through the
 * SURFACE-supplied port. The plan-mode store does NOT own a free-form
 * "plan text" — it owns structured todos. We therefore surface a tiny
 * `PlanEditPort` that the COMPOSITION ROOT (or a future REPL surface)
 * wires to either:
 *   (a) the plan-queue as a fresh follow-up labeled `external_editor`
 *       so the next turn reads the edited text; or
 *   (b) a structured plan re-parser that converts markdown todos back to
 *       `update_plan` mutations (out of scope for ADR-0225; left as a
 *       seam for a follow-up ADR).
 *
 * Default-OFF: `ctx.planEdit` absent ⇒ "not wired in this surface" + exit
 * 0 (parity with the rest of the BUILTINS).
 *
 * Slice posture (RFC §3.1):
 *   - Lives in `apps/cli`. Imports `node:fs/promises`, `node:os`,
 *     `node:path`, `node:child_process` + the local `./slash-commands`.
 *     NO `@/agent`, NO `@/agent/plan-queue` — the port is duck-typed
 *     here so we keep slice fence + the surface owns the wire.
 *   - exactOptionalPropertyTypes-clean.
 *   - No-throw on the public surface: every spawn / fs failure is a typed
 *     exit code with a stderr line.
 *
 * Editor selection priority:
 *   1. `ctx.editorOverride` (test seam).
 *   2. `$VISUAL` env (Aider + classic Unix convention).
 *   3. `$EDITOR` env.
 *   4. `vi` (last-resort POSIX default).
 *
 * Empty-edit semantics: when the editor exits with the file UNCHANGED
 * (byte-identical to the pre-edit body), the slash prints "/edit-plan:
 * unchanged" and exits 0 WITHOUT calling `planEdit.setPlan(...)`. Treat
 * editor-cancel as user-intentional NO-OP.
 */

import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
import type { SlashCommand } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

// The `PlanEditPort` CONTRACT lives in `@/agent/surface-ports` (the agent core
// owns it; this surface implements + wires it). Re-exported here so the existing
// `./edit-plan-cmd` importers (slash-surface, plan-edit-adapter) are unaffected.
export type { PlanEditPort } from "@/agent/surface-ports"

import type { PlanEditPort } from "@/agent/surface-ports"

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0225 plan-edit wire. Absent ⇒ "not wired in this surface". */
    readonly planEdit?: PlanEditPort | undefined
    /** Test seam: pin the editor command verbatim, bypass $VISUAL/$EDITOR
     *  discovery. Honored by both `/edit-plan` and `/edit-message`. */
    readonly editorOverride?: string | undefined
    /** Test seam: pin the env reader. Default `process.env`. */
    readonly editorEnv?: NodeJS.ProcessEnv | undefined
    /** Test seam: pin the spawn impl. Default `node:child_process.spawn`
     *  wired to the editor as `[cmd, args, { stdio: "inherit" }]`. The
     *  promise resolves with the exit code (or 127 on spawn error). */
    readonly editorSpawn?: ((cmd: string, args: readonly string[]) => Promise<number>) | undefined
  }
}

/* ------------------------------------------------------------------ */
/* editor command discovery                                            */
/* ------------------------------------------------------------------ */

/** Returns `{cmd, args}` after splitting the editor on whitespace. Honors
 *  the common `vim -O` / `code --wait` pattern: the first token is the
 *  binary, the rest are leading args (the file path is appended last). */
export const parseEditorCommand = (raw: string): { cmd: string; args: readonly string[] } => {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return { cmd: "vi", args: [] }
  return { cmd: tokens[0] as string, args: tokens.slice(1) }
}

/** Resolve the editor command per the documented priority. Pure. */
export const resolveEditor = (
  override: string | undefined,
  env: NodeJS.ProcessEnv,
): { cmd: string; args: readonly string[] } => {
  if (override !== undefined && override.trim() !== "") return parseEditorCommand(override)
  const visual = env.VISUAL
  if (visual !== undefined && visual.trim() !== "") return parseEditorCommand(visual)
  const editor = env.EDITOR
  if (editor !== undefined && editor.trim() !== "") return parseEditorCommand(editor)
  return { cmd: "vi", args: [] }
}

/* ------------------------------------------------------------------ */
/* spawn helper                                                        */
/* ------------------------------------------------------------------ */

export const defaultEditorSpawn = (cmd: string, args: readonly string[]): Promise<number> =>
  new Promise<number>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: "inherit" })
    } catch {
      resolve(127)
      return
    }
    let settled = false
    child.on("error", () => {
      if (settled) return
      settled = true
      resolve(127)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      resolve(code ?? 1)
    })
  })

/* ------------------------------------------------------------------ */
/* shared edit driver (used by /edit-plan and /edit-message)            */
/* ------------------------------------------------------------------ */

export interface EditInTempArgs {
  readonly body: string
  readonly suffix: string
  readonly editor: { cmd: string; args: readonly string[] }
  readonly spawn: (cmd: string, args: readonly string[]) => Promise<number>
  readonly tmpRoot?: string
}

export type EditInTempResult =
  | { readonly kind: "ok"; readonly text: string; readonly changed: boolean }
  | { readonly kind: "spawn_failed"; readonly cmd: string }
  | { readonly kind: "editor_failed"; readonly cmd: string; readonly code: number }
  | {
      readonly kind: "fs_failed"
      readonly stage: "mkdtemp" | "write" | "read"
      readonly message: string
    }

/** Write `body` to a fresh temp file, spawn `$EDITOR <path>`, read the
 *  edited bytes back, return a typed result. No-throw on every failure
 *  mode; the caller renders the message. Pure of the SlashContext —
 *  reusable by `/edit-plan` AND `/edit-message`. */
export const editInTemp = async (a: EditInTempArgs): Promise<EditInTempResult> => {
  let dir: string
  try {
    dir = await mkdtemp(join(a.tmpRoot ?? tmpdir(), "quanta-edit-"))
  } catch (e) {
    return {
      kind: "fs_failed",
      stage: "mkdtemp",
      message: errMessage(e),
    }
  }
  const path = join(dir, `quanta.${a.suffix}`)
  try {
    await writeFile(path, a.body, "utf8")
  } catch (e) {
    return {
      kind: "fs_failed",
      stage: "write",
      message: errMessage(e),
    }
  }
  const code = await a.spawn(a.editor.cmd, [...a.editor.args, path])
  if (code === 127) return { kind: "spawn_failed", cmd: a.editor.cmd }
  if (code !== 0) return { kind: "editor_failed", cmd: a.editor.cmd, code }
  let edited: string
  try {
    edited = await readFile(path, "utf8")
  } catch (e) {
    return { kind: "fs_failed", stage: "read", message: errMessage(e) }
  }
  return { kind: "ok", text: edited, changed: edited !== a.body }
}

/* ------------------------------------------------------------------ */
/* render helper (shared with /edit-message)                            */
/* ------------------------------------------------------------------ */

/** Translate an {@link EditInTempResult} into a stderr line + exit code.
 *  Returns `null` when the result is a CHANGED `ok` outcome (the caller
 *  proceeds to call `setX(...)`) and `{ exit: 0 }` on UNCHANGED. Pure of
 *  the SlashContext; reusable across `/edit-plan` and `/edit-message`. */
export const renderEditResult = (
  res: EditInTempResult,
  slashName: string,
  out: (s: string) => void,
  err: (s: string) => void,
): { exit: number } | null => {
  if (res.kind === "spawn_failed") {
    err(`${slashName}: editor not found: ${res.cmd} (set $EDITOR or install vi)\n`)
    return { exit: 1 }
  }
  if (res.kind === "editor_failed") {
    err(`${slashName}: editor exited with code ${res.code}\n`)
    return { exit: 1 }
  }
  if (res.kind === "fs_failed") {
    err(`${slashName}: ${res.stage} failed: ${res.message}\n`)
    return { exit: 1 }
  }
  if (!res.changed) {
    out(`${slashName}: unchanged\n`)
    return { exit: 0 }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* command                                                              */
/* ------------------------------------------------------------------ */

export const editPlanCmd: SlashCommand = {
  name: "/edit-plan",
  describe: "Open the current plan in $EDITOR for mid-execution edits",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err(`/edit-plan: takes no arguments; got ${args.length}\n`)
      return 1
    }
    if (ctx.planEdit === undefined) {
      ctx.out("/edit-plan: not wired in this surface\n")
      return 0
    }
    let current: string
    try {
      const v = ctx.planEdit.getPlan()
      current = v instanceof Promise ? await v : v
    } catch (e) {
      ctx.err(`/edit-plan: getPlan failed: ${errMessage(e)}\n`)
      return 1
    }
    const editor = resolveEditor(ctx.editorOverride, ctx.editorEnv ?? process.env)
    const spawnFn = ctx.editorSpawn ?? defaultEditorSpawn
    const res = await editInTemp({
      body: current,
      suffix: "plan.md",
      editor,
      spawn: spawnFn,
    })
    const rendered = renderEditResult(res, "/edit-plan", ctx.out, ctx.err)
    if (rendered !== null) return rendered.exit
    // res is the OK + changed branch — narrow for setPlan call.
    if (res.kind !== "ok") return 1
    try {
      const r = ctx.planEdit.setPlan(res.text)
      if (r instanceof Promise) await r
    } catch (e) {
      ctx.err(`/edit-plan: setPlan failed: ${errMessage(e)}\n`)
      return 1
    }
    ctx.out(`/edit-plan: updated (${res.text.length} chars)\n`)
    return 0
  },
}

/** Test-only re-exports. */
export const __test = {
  parseEditorCommand,
  resolveEditor,
  editInTemp,
  defaultEditorSpawn,
}
