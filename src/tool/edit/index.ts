import { z } from "zod"
import { defaultFileSystemPort, type FileSystemPort, FsJailError, sha256Hex } from "@/storage"
import { gitWriteGuardDeny } from "../git-write-guard-result"
import { guardWrite } from "../stale-read-guard"
import { captureToolDiff } from "../tool-diff-capture"
import type { Tool, ToolContext, ToolEvent, ToolFailure } from "../types"
import { applyExactEdit } from "./exact"
import { applyFuzzyEdit } from "./fuzzy"
import { type LineRange, lineCount, validateLineRanges } from "./line-range"
import { classifyMismatch, formatEditMismatchMarker, formatStrategyHint } from "./strategy-hint"

const schema = z.object({
  path: z.string().describe("File path to edit"),
  old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  fuzzy: z
    .boolean()
    .optional()
    .describe(
      "If exact match fails, retry with whitespace-tolerant fuzzy matching (default false)",
    ),
  /** H12 — OPTIONAL 1-indexed inclusive line ranges constraining WHERE
   *  old_string is matched. Use it to disambiguate a repeated anchor without
   *  adding surrounding context: "the occurrence on lines 40-60". Absent ⇒
   *  whole-file search (byte-identical legacy). */
  line_ranges: z
    .array(
      z.object({
        start: z.number().describe("First line of the span (1-indexed, inclusive)"),
        end: z.number().describe("Last line of the span (1-indexed, inclusive)"),
      }),
    )
    .optional()
    .describe(
      "Restrict matching to these 1-indexed inclusive line ranges. Disambiguates a " +
        "repeated old_string by scope instead of extra context. Absent ⇒ whole file.",
    ),
  /** ADR-0398 — OPTIONAL sha256 hex precondition. When supplied, the tool
   *  computes the sha256 of the file's CURRENT bytes and refuses the write if
   *  it differs. Returns `failure.mode: "stale_precondition"` with the two
   *  hashes; the on-disk content is untouched. Default-OFF: absent ⇒ legacy
   *  byte-identical behavior. */
  expected_hash: z
    .string()
    .optional()
    .describe("If set, refuse the edit unless sha256(current file) == this hex."),
})

type Input = z.infer<typeof schema>

/** Build the `ok:false` mismatch `ToolResult` when neither the exact nor the
 *  fuzzy edit applied. Extracted from `execute` (pure: no I/O) so the generator
 *  body stays flat. Phase-4 strategy-hint semantics are unchanged — it
 *  classifies via the structural `result.kind` tag when present and appends the
 *  stable `[edit-mismatch:<kind>]` marker so out-of-process consumers can
 *  recover the kind without re-sniffing the message text. */
const buildMismatchResult = (
  result: {
    message: string
    kind?: Parameters<typeof formatEditMismatchMarker>[0]
  },
  path: string,
  fileLineCount?: number,
): { ok: false; output: string; failure: ToolFailure } => {
  const next = classifyMismatch(result.kind !== undefined ? { kind: result.kind } : result.message)
  const hint = formatStrategyHint(next)
  const marker = result.kind !== undefined ? ` ${formatEditMismatchMarker(result.kind)}` : ""
  // H12 — append the file's total line count (when the caller passed it) so the
  // model can pick a VALID `line_ranges` span on retry instead of guessing. The
  // caller only supplies it for the AMBIGUOUS / already-scoped failure classes,
  // so other failures' output stays byte-identical.
  const lineNote = fileLineCount !== undefined ? `\n(the file has ${fileLineCount} lines)` : ""
  // The old_string did not match: the target text was not found in the file.
  // Typed as `not_found` so the model branches to re-read / fuzzy instead of
  // regex-sniffing the hint text. `output` is unchanged (byte-identical).
  return {
    ok: false,
    output: `${result.message}${marker}\n\n${hint}${lineNote}`,
    failure: { mode: "not_found", path },
  }
}

/** ADR-0398 — pure precondition gate. Returns a `stale_precondition` failure
 *  result when `expectedHash` is set and disagrees with `sha256Hex(source)`;
 *  returns `null` when the precondition is absent or matching (commit may
 *  proceed). Extracted so the generator body stays under the biome cognitive-
 *  complexity cap. */
const checkHashPrecondition = (
  source: string,
  path: string,
  expectedHash: string | undefined,
): { ok: false; output: string; failure: ToolFailure } | null => {
  if (expectedHash === undefined) return null
  const actualHash = sha256Hex(source)
  if (actualHash === expectedHash) return null
  const failure: ToolFailure = {
    mode: "stale_precondition",
    path,
    expectedHash,
    actualHash,
  }
  return {
    ok: false,
    output:
      `stale_precondition: ${path} sha256 ${actualHash} != expected ${expectedHash}. ` +
      "Re-read the file and re-issue the edit with the fresh expected_hash.",
    failure,
  }
}

/** Plan the edit: read the file, gate on the optional hash precondition,
 *  apply exact (then fuzzy if requested) replacement. Returns either a typed
 *  failure result (early exit) or the new bytes ready to commit. No I/O
 *  beyond the initial read; extracted to keep `execute` under the biome
 *  cognitive-complexity cap. */
const planEdit = async (
  fs: FileSystemPort,
  input: Input,
  cwd: string | undefined,
): Promise<
  | { kind: "ready"; before: string; next: string; message: string }
  | { kind: "failure"; result: { ok: false; output: string; failure: ToolFailure } }
> => {
  const source = await fs.readFile(input.path, cwd)
  const preconditionFailure = checkHashPrecondition(source, input.path, input.expected_hash)
  if (preconditionFailure !== null) return { kind: "failure", result: preconditionFailure }
  // H12 — validate caller-supplied line ranges BEFORE matching. A malformed
  // range is a model error, surfaced as `rejected` so it fixes the span rather
  // than wondering why the edit "found nothing". Absent ⇒ undefined (whole-file
  // search, byte-identical legacy path).
  const lineRanges: readonly LineRange[] | undefined =
    input.line_ranges !== undefined && input.line_ranges.length > 0 ? input.line_ranges : undefined
  if (lineRanges !== undefined) {
    const verdict = validateLineRanges(lineRanges)
    if (!verdict.ok) {
      return {
        kind: "failure",
        result: {
          ok: false,
          output: verdict.message,
          failure: { mode: "rejected", reason: verdict.message },
        },
      }
    }
  }
  const replaceAll = input.replace_all ?? false
  let result = applyExactEdit(source, input.old_string, input.new_string, replaceAll, lineRanges)
  if ((!result.ok || result.next === undefined) && input.fuzzy) {
    result = applyFuzzyEdit(source, input.old_string, input.new_string, replaceAll, lineRanges)
  }
  if (!result.ok || result.next === undefined) {
    // H12 paired improvement — annotate AMBIGUOUS failures (the anchor matched
    // multiple spots) with the file's total line count so the model can pick a
    // `line_ranges` value on retry to disambiguate by scope, instead of a blind
    // re-guess. Scoped failures (line_ranges already supplied, but still no/2+
    // in-range match) also get it so the model can widen/narrow the span. Other
    // failure classes (not-found / fuzzy-no-confident) keep their byte-identical
    // legacy output — a line count doesn't help re-find missing text.
    const wantsLineCount = result.kind === "ambiguous" || lineRanges !== undefined
    const fileLineCount = wantsLineCount ? lineCount(source) : undefined
    return { kind: "failure", result: buildMismatchResult(result, input.path, fileLineCount) }
  }
  // Surface the pre-edit `source` so a SUCCESSFUL commit can hand the
  // before/after to the optional tool-diff sink (ADR-0440) — no recompute,
  // no second read; this is the read we already did to plan the edit.
  return { kind: "ready", before: source, next: result.next, message: result.message }
}

/** ADR-0398 — route the commit through `writeFileAtomic` when the caller
 *  threaded `expected_hash` AND the port supports it; otherwise legacy
 *  `writeFile`. jun-6 tool-interrupt-behavior — the commit runs inside the
 *  OPTIONAL critical section (`ctx.criticalSection`) so an in-flight ESC cannot
 *  tear a half-written file; `begin?.()` is undefined when the seam is unwired
 *  (the three OFF gates) ⇒ byte-identical legacy path. The withheld abort (if
 *  any) is re-delivered at `end()` so the next phase boundary still aborts the
 *  turn. Extracted to keep `execute` flat. */
const commitEdit = async (
  fs: FileSystemPort,
  ctx: ToolContext,
  path: string,
  next: string,
  expectedHash: string | undefined,
): Promise<void> => {
  const cs = ctx.criticalSection?.begin()
  try {
    if (expectedHash !== undefined && fs.writeFileAtomic !== undefined) {
      await fs.writeFileAtomic(path, next, ctx.cwd)
      return
    }
    await fs.writeFile(path, next, ctx.cwd)
  } finally {
    cs?.end()
  }
}

/** Build the `edit` tool against an injected {@link FileSystemPort} (#13).
 *  `fs` defaults to the real `@/storage`-backed port, so the exported
 *  {@link editTool} is byte-identical to the pre-port direct-call version;
 *  tests pass an in-memory port for isolation. */
export const makeEditTool = (fs: FileSystemPort = defaultFileSystemPort): Tool<Input> => ({
  name: "edit",
  // ADR-0410 — when-not-to-use clause. Codex L83-110 (`apply_patch`) and
  // Claude Code 2.1.138 `tools/Edit.ts` both attach a do-not-use list to the
  // edit description; the negative anchors cut a recurring mis-routing
  // (write-when-edit, edit-when-write, ambiguous old_string).
  description:
    "Exact string replacement in an existing file. old_string must match verbatim. " +
    "Do NOT use edit to create a new file — use `write` instead. " +
    "Do NOT use edit when old_string is not unique in the file — include more " +
    "surrounding context to make it unique, or set `replace_all: true` for " +
    "intentional bulk replacement.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Mutates the filesystem; conservatively never run concurrently.
  isConcurrencySafe: () => false,
  // HITL secure-by-default (ADR-0020 follow-up): targeted edit on an
  // existing file is reversible-in-VCS — pre-approval covers it. Required
  // explicit opt-in since the fallback for mutating tools is now
  // `always-confirm`.
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
  // jun-6 tool-interrupt-behavior — `edit` is an ATOMIC-intent applier (its
  // in-place strategies are not all rename-atomic): an ESC mid-commit can leave
  // a half-written file. Declare `"block"` so the dispatch abort-router withholds
  // the turn abort ONLY while the commit window below is open. Default-OFF /
  // byte-identical unless the host wired `ctx.criticalSection` AND the
  // `QUANTA_TOOL_INTERRUPT_BLOCK` knob is on (see ToolInterruptPolicy).
  interruptBehavior: (): "block" => "block",

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // ADR-0091 git-write-protection: an edit targeting `.git/{hooks,config,
    // config.worktree,info/attributes}` or `.vscode/**` is a code-execution /
    // policy-escape vector. Static-deny BEFORE the read, mirroring the
    // FsJailError hard-stop below — never a partial write. Default-OFF: absent
    // `ctx.gitWriteGuard` the helper returns null (byte-identical legacy path).
    const guardDeny = gitWriteGuardDeny(input.path, ctx)
    if (guardDeny) {
      yield guardDeny
      return
    }
    // Resolve relative paths against the session cwd, not process.cwd().
    // The jail check fires in readFile() (and again in writeFile()) BEFORE
    // any write, so a denied path is NEVER a partial write.
    try {
      const planned = await planEdit(fs, input, ctx.cwd)
      if (planned.kind === "failure") {
        yield { type: "result", result: planned.result }
        return
      }
      // ADR-0474 — stale-read-guard: block editing a file that was READ earlier
      // this session and externally modified since (mtime advanced), telling the
      // model to re-read. No-op when the guard is unwired (ctx.readFileState
      // absent) or the path was never read (guardWrite returns ok for `unread`).
      if (ctx.readFileState !== undefined) {
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
      }
      // jun-6 tool-interrupt-behavior — the commit runs inside the OPTIONAL
      // critical section (inside `commitEdit`) so an in-flight ESC cannot tear a
      // half-written file (no-op when the seam is unwired; byte-identical).
      await commitEdit(fs, ctx, input.path, planned.next, input.expected_hash)
      // ADR-0440 — feed the before/after to the optional tool-diff sink so the
      // web-daemon emits a `tool.diff` canvas frame. Default-OFF: no-op unless
      // `ctx.toolDiff` + `ctx.toolCallId` are both wired (gate ON). No recompute
      // (the daemon runs the diff once); the file is already written, so the
      // helper swallows any sink throw.
      captureToolDiff(ctx, planned.before, planned.next, input.path)
      yield { type: "result", result: { ok: true, output: `${input.path}: ${planned.message}` } }
    } catch (e) {
      if (e instanceof FsJailError) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: e.message,
            failure: { mode: "permission_denied", path: input.path, isReadonly: false },
          },
        }
        return
      }
      throw e
    }
  },
})

/** Default-port `edit` tool used by the registry. */
export const editTool: Tool<Input> = makeEditTool()
