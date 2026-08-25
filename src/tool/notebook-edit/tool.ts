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

type OpOrError = NotebookEditOp | { readonly error: string }

/** One builder per mode. They were three arms of a single `switch`, where every
 *  required-field guard paid a nesting surcharge for sitting inside a `case`;
 *  hoisted out, each arm is a flat precondition list that also keeps TS's
 *  `!== undefined` narrowing (a shared table-driven guard would not — the
 *  builder would need a cast to re-widen each optional field). Guard ORDER is
 *  load-bearing: it decides WHICH missing field the model is told about first. */
const strReplaceOp = (input: Input): OpOrError => {
  if (input.cell === undefined) return { error: "str_replace requires `cell`" }
  if (input.old_string === undefined || input.new_string === undefined)
    return { error: "str_replace requires `old_string` and `new_string`" }
  return {
    kind: "str_replace",
    cell: input.cell,
    oldStr: input.old_string,
    newStr: input.new_string,
    // `exactOptionalPropertyTypes`: an explicit `replaceAll: undefined` is NOT
    // the same as an absent key, so the flag is spread in only when supplied.
    ...(input.replace_all !== undefined ? { replaceAll: input.replace_all } : {}),
  }
}

const insertOp = (input: Input): OpOrError => {
  if (input.index === undefined) return { error: "insert requires `index`" }
  if (input.cell_type === undefined) return { error: "insert requires `cell_type`" }
  if (input.source === undefined) return { error: "insert requires `source`" }
  return { kind: "insert", index: input.index, cellType: input.cell_type, source: input.source }
}

const deleteOp = (input: Input): OpOrError => {
  if (input.cell === undefined) return { error: "delete requires `cell`" }
  return { kind: "delete", cell: input.cell }
}

/** Map the flat tool input to a typed {@link NotebookEditOp}, or a usage error. */
const toOp = (input: Input): OpOrError => {
  switch (input.mode) {
    case "str_replace":
      return strReplaceOp(input)
    case "insert":
      return insertOp(input)
    case "delete":
      return deleteOp(input)
    default:
      return { error: "unknown mode" }
  }
}

const err = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output, failure: { mode: "error", modelVisibleError: output } },
})

/** Everything decidable BEFORE touching the filesystem, in the order the tool
 *  must apply it: the abort check, then the two STATIC write-denies `edit` runs
 *  (git-escape-vector + the jun-6 glob-in-write guard, both on the RAW
 *  `input.path` so a notebook under a protected path is denied consistently
 *  with `edit`/`write`), then the extension gate. Order is behaviour: a
 *  protected non-`.ipynb` path must report the DENIAL, not the extension. */
const preflightDenial = (input: Input, ctx: ToolContext): ToolEvent | null => {
  if (ctx.signal?.aborted === true) return err("aborted before start")
  const staticDeny = gitWriteGuardDeny(input.path, ctx) ?? globWriteGuardEvent(input.path, ctx)
  if (staticDeny !== null) return staticDeny
  if (!/\.ipynb$/i.test(input.path))
    return err("notebook_edit only edits .ipynb files — use `edit` for plain text")
  return null
}

/** The read, with its fault collapsed to a terminal event. A unit because the
 *  caller wants EITHER the bytes OR something to yield — never a thrown read. */
const readNotebook = async (
  fs: FileSystemPort,
  input: Input,
  ctx: ToolContext,
): Promise<{ readonly raw: string } | { readonly event: ToolEvent }> => {
  try {
    return { raw: await fs.readFile(input.path, ctx.cwd) }
  } catch (e) {
    return { event: err(`read failed: ${errMessage(e)}`) }
  }
}

/** ADR-0474 stale-read guard (EDIT PARITY): refuse to write over a notebook that
 *  changed since the model last read it. Default-OFF seam — absent
 *  `readFileState` ⇒ `null` ⇒ byte-identical. A stat fault also returns `null`
 *  (the read above already proved the file exists; the guard is best-effort like
 *  edit's). Its own unit so `execute` holds neither the seam check nor the
 *  swallowing try. */
const staleReadDenial = async (
  fs: FileSystemPort,
  input: Input,
  ctx: ToolContext,
): Promise<ToolEvent | null> => {
  // Bind the mutable ctx property to a `const` FIRST: the narrowing from the
  // `undefined` check does not survive the `await` on a property read.
  const state = ctx.readFileState
  if (state === undefined) return null
  try {
    const cur = await fs.statFile(input.path, ctx.cwd)
    const guard = guardWrite(state, cur.path, cur.mtimeMs)
    if (guard.ok) return null
    return {
      type: "result",
      result: {
        ok: false,
        output: guard.error.message,
        failure: { mode: "rejected", reason: "stale_read" },
      },
    }
  } catch {
    // stat fault — proceed (read already proved the file exists).
    return null
  }
}

/** The commit: ATOMIC (temp+rename) when the port offers it, plain `writeFile`
 *  for the in-memory test ports that don't. Returns the failure event, or `null`
 *  when the bytes landed. */
const commitWrite = async (
  fs: FileSystemPort,
  input: Input,
  ctx: ToolContext,
  json: string,
): Promise<ToolEvent | null> => {
  try {
    if (fs.writeFileAtomic !== undefined) await fs.writeFileAtomic(input.path, json, ctx.cwd)
    else await fs.writeFile(input.path, json, ctx.cwd)
    return null
  } catch (e) {
    return err(`write failed: ${errMessage(e)}`)
  }
}

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
    const denied = preflightDenial(input, ctx)
    if (denied !== null) {
      yield denied
      return
    }
    const op = toOp(input)
    if ("error" in op) {
      yield err(`invalid notebook_edit input: ${op.error}`)
      return
    }
    const read = await readNotebook(fs, input, ctx)
    if ("event" in read) {
      yield read.event
      return
    }
    const edited = editNotebook(read.raw, op)
    if (!edited.ok) {
      yield err(`notebook_edit: ${edited.reason}`)
      return
    }
    const stale = await staleReadDenial(fs, input, ctx)
    if (stale !== null) {
      yield stale
      return
    }
    // jun-6 exfil-rail — per-turn write budget (EDIT PARITY). Default-OFF ⇒ null.
    // Placed AFTER the stale guard on purpose: a rejected write must not consume
    // a unit of the turn's budget.
    const budget = writeBudgetEvent(ctx)
    if (budget !== null) {
      yield budget
      return
    }
    const writeFault = await commitWrite(fs, input, ctx, edited.json)
    if (writeFault !== null) {
      yield writeFault
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
