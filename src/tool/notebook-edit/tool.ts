/**
 * W6 — `notebook_edit` tool wrapper. Reads a `.ipynb` through the SAME
 * `@/storage` FS jail the readers/`edit` use, applies a pure {@link editNotebook}
 * cell op, and writes back ATOMICALLY (temp+rename via the port's
 * `writeFileAtomic`, falling back to `writeFile` for in-memory test ports).
 *
 * Mutating + secure-by-default: `isReadOnly:false`, `hitlTier:pre-approval-ok`
 * (a targeted cell edit on an existing notebook is VCS-reversible). NEVER throws
 * — a read/parse/write fault or a missing/ambiguous match collapses to an
 * `ok:false` tool_result. Default-OFF: registered ONLY when QUANTA_NOTEBOOK_EDIT
 * is on (tool menu byte-identical otherwise).
 */
import { z } from "zod"
import { errMessage } from "@/shared"
import { defaultFileSystemPort, type FileSystemPort } from "@/storage"
import { globWriteGuardEvent, writeBudgetEvent } from "../_shared/exfil-rail-guards"
import { refreshStaleReadBaseline } from "../_shared/fresh-hash"
import { captureFileHistory } from "../file-history/capture"
import { gitWriteGuardDeny } from "../git-write-guard-result"
import { guardWrite } from "../stale-read-guard"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { editNotebook, type NotebookEditOp } from "./index"

const schema = z.object({
  path: z.string().min(1).describe("Path to the .ipynb notebook (relative to cwd or absolute)."),
  mode: z
    .enum(["str_replace", "insert", "delete"])
    .describe("str_replace: replace text in a cell. insert: add a cell. delete: remove a cell."),
  cell: z.number().int().optional().describe("0-based cell index (str_replace / delete)."),
  old_string: z.string().optional().describe("str_replace: text to find within the cell."),
  new_string: z.string().optional().describe("str_replace: replacement text."),
  replace_all: z
    .boolean()
    .optional()
    .describe("str_replace: replace every occurrence in the cell."),
  index: z.number().int().optional().describe("insert: 0-based position (0..cellCount)."),
  cell_type: z.enum(["code", "markdown"]).optional().describe("insert: new cell type."),
  source: z.string().optional().describe("insert: the new cell's source text."),
})
type Input = z.infer<typeof schema>

/** Map the flat tool input to a typed {@link NotebookEditOp}, or a usage error. */
const toOp = (input: Input): NotebookEditOp | { readonly error: string } => {
  switch (input.mode) {
    case "str_replace":
      if (input.cell === undefined) return { error: "str_replace requires `cell`" }
      if (input.old_string === undefined || input.new_string === undefined)
        return { error: "str_replace requires `old_string` and `new_string`" }
      return {
        kind: "str_replace",
        cell: input.cell,
        oldStr: input.old_string,
        newStr: input.new_string,
        ...(input.replace_all !== undefined ? { replaceAll: input.replace_all } : {}),
      }
    case "insert":
      if (input.index === undefined) return { error: "insert requires `index`" }
      if (input.cell_type === undefined) return { error: "insert requires `cell_type`" }
      if (input.source === undefined) return { error: "insert requires `source`" }
      return { kind: "insert", index: input.index, cellType: input.cell_type, source: input.source }
    case "delete":
      if (input.cell === undefined) return { error: "delete requires `cell`" }
      return { kind: "delete", cell: input.cell }
    default:
      return { error: "unknown mode" }
  }
}

const err = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output, failure: { mode: "error", modelVisibleError: output } },
})

/** Build the `notebook_edit` tool against an injected FS port (defaults to the
 *  real `@/storage` jail; tests pass an in-memory port). */
export const makeNotebookEditTool = (fs: FileSystemPort = defaultFileSystemPort): Tool<Input> => ({
  name: "notebook_edit",
  description:
    "Edit a Jupyter .ipynb notebook by CELL: str_replace text within a cell, insert a new cell, " +
    "or delete a cell. Preserves all other cells and notebook metadata. Use `read` first to see " +
    "cell indices. For plain text files use `edit`, not notebook_edit.",
  inputSchema: schema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    if (ctx.signal?.aborted === true) {
      yield err("aborted before start")
      return
    }
    // Same static write-denies `edit` runs (default-OFF ⇒ null ⇒ byte-identical):
    // git-escape-vector protection + the jun-6 glob-in-write guard. Run on the
    // raw `input.path` (path-shape matchers) BEFORE any read/write so a notebook
    // under a protected path is denied consistently with `edit`/`write`.
    const staticDeny = gitWriteGuardDeny(input.path, ctx) ?? globWriteGuardEvent(input.path, ctx)
    if (staticDeny !== null) {
      yield staticDeny
      return
    }
    if (!/\.ipynb$/i.test(input.path)) {
      yield err("notebook_edit only edits .ipynb files — use `edit` for plain text")
      return
    }
    const op = toOp(input)
    if ("error" in op) {
      yield err(`invalid notebook_edit input: ${op.error}`)
      return
    }
    let raw: string
    try {
      raw = await fs.readFile(input.path, ctx.cwd)
    } catch (e) {
      yield err(`read failed: ${errMessage(e)}`)
      return
    }
    const edited = editNotebook(raw, op)
    if (!edited.ok) {
      yield err(`notebook_edit: ${edited.reason}`)
      return
    }
    // ADR-0474 stale-read guard (EDIT PARITY): refuse to write over a notebook
    // that changed since the model last read it. Default-OFF seam — absent
    // `readFileState` ⇒ byte-identical. A stat fault falls through (the read
    // above already succeeded; the guard is best-effort like edit's).
    if (ctx.readFileState !== undefined) {
      try {
        const cur = await fs.statFile(input.path, ctx.cwd)
        const guard = guardWrite(ctx.readFileState, cur.path, cur.mtimeMs)
        if (!guard.ok) {
          yield {
            type: "result",
            result: {
              ok: false,
              output: guard.error.message,
              failure: { mode: "rejected", reason: "stale_read" },
            },
          }
          return
        }
      } catch {
        // stat fault — proceed (read already proved the file exists).
      }
    }
    // jun-6 exfil-rail — per-turn write budget (EDIT PARITY). Default-OFF ⇒ null.
    const budget = writeBudgetEvent(ctx)
    if (budget !== null) {
      yield budget
      return
    }
    try {
      if (fs.writeFileAtomic !== undefined)
        await fs.writeFileAtomic(input.path, edited.json, ctx.cwd)
      else await fs.writeFile(input.path, edited.json, ctx.cwd)
    } catch (e) {
      yield err(`write failed: ${errMessage(e)}`)
      return
    }
    // file_history capture (EDIT PARITY) — records the post-write content so
    // `file_history_rewind` / `/rewind-tool` can restore a notebook edit exactly
    // like an `edit`. No-throw; absent sink ⇒ no-op.
    captureFileHistory(ctx, input.path, edited.json)
    // jul-13 edit-fresh-hash (EDIT PARITY, refresh-only) — notebook_edit mutates the
    // .ipynb and uses the SAME DEFAULT-ON mtime stale-read guard as edit/write, so
    // without refreshing the baseline a chained no-re-read notebook_edit/edit to the
    // same file would be vetoed `stale_read`. Record the just-written mtime (gated ⇒
    // byte-identical when off). No fresh-hash EMISSION: notebook_edit is cell-op
    // based and does not consume `expected_hash`, so the single-flat-file chain
    // contract does not apply (refresh-only, like apply_patch).
    await refreshStaleReadBaseline(fs, ctx, { path: input.path, base: ctx.cwd }, edited.json)
    yield {
      type: "result",
      result: { ok: true, output: `notebook_edit: ${edited.summary} in ${input.path}` },
    }
  },
})

/** Default-bound tool (real FS port) for the registry. */
export const notebookEditTool: Tool<Input> = makeNotebookEditTool()
