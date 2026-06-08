import { z } from "zod"
import { defaultFileSystemPort, type FileSystemPort, FsJailError, sha256Hex } from "@/storage"
import { globWriteGuardEvent, writeBudgetEvent } from "../_shared/exfil-rail-guards"
import { captureFileHistory } from "../file-history/capture"
import { gitWriteGuardDeny } from "../git-write-guard-result"
import { guardWrite } from "../stale-read-guard"
import { captureToolDiff } from "../tool-diff-capture"
import type { Tool, ToolContext, ToolEvent, ToolFailure } from "../types"
import { resolveEditBase } from "../worktree/cwd-override"
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

/** jun-7-misc 06 (ADR ≥0497) — the elision marker the derived sketch uses to
 *  stand in for unchanged regions (Cursor 3.5.33's apply IO convention). Hoisted
 *  to a named constant so the sketch builder AND the consumer's reject-on-leftover
 *  check (R4 FINDING 6) reference the SAME literal — they can never drift. */
const ELISION_MARKER = "// ... existing code ..."

/** jun-7-misc 06 (ADR ≥0497) — derive a terse, Cursor-style edit sketch from the
 *  already-failed `old_string`/`new_string` (Open-Q §9.5 decision: DERIVE, never
 *  change the main model's output contract). The sketch fences the new text
 *  between two `// ... existing code ...` elisions so the apply model knows the
 *  unchanged regions are preserved and only the named region changes. Pure. */
const buildEditSketch = (oldString: string, newString: string): string =>
  [
    ELISION_MARKER,
    `// replace this exact region:`,
    oldString,
    "// with:",
    newString,
    ELISION_MARKER,
  ].join("\n")

/** Count NON-OVERLAPPING occurrences of `needle` in `haystack`. Pure, deterministic.
 *  `needle` is always nonempty at the call site (the empty-new_string case is
 *  rejected before this runs), so the split-length identity is exact. */
const occurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : haystack.split(needle).length - 1

/** jun-7-misc 06 — EDIT-SCOPED verification of a model-merged file (ticket §4.c).
 *  The runner already ran the generic structural check (non-empty, changed,
 *  no leftover elision marker); this adds the bounds the EDIT knows about:
 *    - the merged file MUST add `new_string` — its occurrence count strictly
 *      INCREASES vs the original (the intended change landed; mere presence is
 *      unsound when new_string already exists unrelated to the edit),
 *    - the merged file MUST NOT still contain `old_string` (unless the new text
 *      itself contains it, e.g. an append) — i.e. the old anchor was resolved,
 *    - the merged file MUST differ from the original (a no-op is not a fix).
 *  Returns the rejection reason, or null when the merge is acceptable AS A
 *  PROPOSAL (it then still flows through the normal gated commit). Conservative
 *  by construction: any doubt ⇒ reject ⇒ fall through to the typed mismatch. */
const verifyEditScopedMerge = (
  original: string,
  merged: string,
  oldString: string,
  newString: string,
): string | null => {
  if (merged === original) return "merged file unchanged"
  // R4 adversarial fix (FINDING 6) — DEFENSE-IN-DEPTH against the duck-typed port.
  // The runner's `verifyMergeStructural` rejects a merge that still literally
  // contains the elision marker (the apply model COPIED the sketch instead of
  // EXPANDING it — dropping the real unchanged lines the marker stood for). But
  // the consumer must NOT trust the port to have run that check: slice isolation
  // means `ctx.fastApplyMerge` is any structural implementation, and a buggy /
  // compromised one could return such a merge with `ok:true`. The marker is a
  // deterministic literal THIS module injected via `buildEditSketch`, so its
  // survival in the merged output is sound, non-heuristic proof the model did not
  // expand the elisions ⇒ real code was dropped ⇒ reject ⇒ fail-closed. Without
  // this, the merge-runner header's "even a runner that returned ok:true on garbage
  // can never reach disk unverified" promise is FALSE for the elision-copy case.
  // Sound, NOT a blanket ban: a marker the merged file LEGITIMATELY carries —
  // because the ORIGINAL already contained it, or the caller's `new_string` itself
  // introduces it (e.g. editing a Cursor-rules doc) — is fine. Only a marker count
  // BEYOND what those two sources account for is the copied-sketch signature.
  // (occurrences split-count is exact; the marker is a fixed nonempty literal.)
  const legitMarkers =
    occurrences(original, ELISION_MARKER) + occurrences(newString, ELISION_MARKER)
  if (occurrences(merged, ELISION_MARKER) > legitMarkers) {
    return "merged file still contains the elision marker (sketch copied, not expanded)"
  }
  // R1 adversarial fix — a DELETION edit (new_string === "") makes the
  // `merged.includes(newString)` "did the change land" check vacuously true (every
  // string contains ""), so a hallucinated merge of arbitrary unrelated content
  // would pass. The merge rung has no trustworthy landed-signal for an empty
  // new_string, so refuse it and fall through to the typed mismatch (fail-closed).
  if (newString.length === 0) return "empty new_string has no verifiable landed signal"
  // R3 adversarial fix — `merged.includes(newString)` (presence ANYWHERE) is an
  // UNSOUND landed-signal when new_string ALREADY occurs in the original
  // (unrelated to this edit): a hallucinated merge that DROPS unrelated lines but
  // keeps the pre-existing occurrence passes vacuously while the edit never
  // landed. The rung only fires when old_string was ABSENT from the original
  // (exact+fuzzy missed), so a real edit MUST strictly INCREASE the count of
  // new_string (it adds the intended text where it was not before). No increase
  // ⇒ no trustworthy proof the edit landed ⇒ fail-closed. Strict-greater is the
  // only sound bound (no magic threshold; no-heuristics-only-validated).
  if (occurrences(merged, newString) <= occurrences(original, newString)) {
    return "merged file does not add new_string (no verifiable landed signal)"
  }
  // The old anchor must be gone — UNLESS the replacement text itself embeds it
  // (append / wrap), in which case its presence is expected. Conservative: only
  // accept when the old anchor is absent OR the new text legitimately re-introduces it.
  if (merged.includes(oldString) && !newString.includes(oldString)) {
    return "merged file still contains old_string (anchor not replaced)"
  }
  return null
}

/** jun-7-misc 06 — the OPTIONAL merge rung. Reached ONLY when the deterministic
 *  exact/fuzzy ladder missed AND `ctx.fastApplyMerge` is wired (gate ON +
 *  apply-model configured). Derives a terse sketch, asks the apply model to
 *  merge it into the CURRENT file, verifies the proposal (runner-level structural
 *  + edit-scoped here), and on success returns the merged bytes for the SAME
 *  gated commit any edit takes. NO-THROW: a port that throws, returns ok:false,
 *  or whose merge fails verification ⇒ `null` ⇒ caller falls through to the
 *  byte-identical typed mismatch. Absent port ⇒ never called (byte-identical). */
const tryFastApplyMergeRung = async (
  ctx: ToolContext,
  source: string,
  input: Input,
  lineRanges: readonly LineRange[] | undefined,
): Promise<string | null> => {
  const port = ctx.fastApplyMerge
  if (port === undefined) return null
  // R1 adversarial fix — when the caller declared a bounded `line_ranges` scope,
  // the deterministic ladder honors it, but a WHOLE-FILE merge cannot. A model
  // merge handed the entire file could mutate lines OUTSIDE the declared scope
  // (e.g. a secret on another line) while still landing new_string — a scope
  // escape the structural checks can't catch. Conservatively skip the rung
  // entirely under line_ranges and fall through to the typed mismatch.
  if (lineRanges !== undefined) return null
  // R2 adversarial fix — `replace_all` is a deterministic contract (change EVERY
  // occurrence of old_string). A whole-file model merge sees only a terse sketch,
  // and the edit-scoped verification checks single-occurrence presence/absence —
  // it CANNOT prove all N sites changed. A merge that changes only one (or the
  // wrong) site still passes `merged.includes(new_string)` while silently
  // violating replace_all. The rung cannot honor that contract, so skip it and
  // fall through to the typed mismatch (fail-closed; no heuristic).
  if (input.replace_all === true) return null
  let result: Awaited<ReturnType<typeof port.apply>>
  try {
    result = await port.apply(
      {
        original: source,
        editSketch: buildEditSketch(input.old_string, input.new_string),
        path: input.path,
      },
      ctx.signal,
    )
  } catch {
    // Port broke its NO-THROW contract — fail-closed to the typed mismatch.
    return null
  }
  if (!result.ok || result.merged === null) return null
  const reject = verifyEditScopedMerge(source, result.merged, input.old_string, input.new_string)
  if (reject !== null) return null
  return result.merged
}

/** H12 — resolve + validate the OPTIONAL caller-supplied `line_ranges`. Returns
 *  `{ ranges }` (undefined ⇒ whole-file, byte-identical legacy) on success, or a
 *  typed `rejected` failure when a supplied range is malformed. Pure; extracted
 *  from `planEdit` to keep it under the biome cognitive-complexity cap. */
const resolveLineRanges = (
  input: Input,
):
  | { ok: true; ranges: readonly LineRange[] | undefined }
  | { ok: false; result: { ok: false; output: string; failure: ToolFailure } } => {
  const ranges: readonly LineRange[] | undefined =
    input.line_ranges !== undefined && input.line_ranges.length > 0 ? input.line_ranges : undefined
  if (ranges === undefined) return { ok: true, ranges: undefined }
  const verdict = validateLineRanges(ranges)
  if (!verdict.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        output: verdict.message,
        failure: { mode: "rejected", reason: verdict.message },
      },
    }
  }
  return { ok: true, ranges }
}

/** Plan the edit: read the file, gate on the optional hash precondition,
 *  apply exact (then fuzzy if requested) replacement. Returns either a typed
 *  failure result (early exit) or the new bytes ready to commit. No I/O
 *  beyond the initial read; extracted to keep `execute` under the biome
 *  cognitive-complexity cap. */
const planEdit = async (
  fs: FileSystemPort,
  input: Input,
  ctx: ToolContext,
  // ticket-11 — the resolved {path,base} the worktree edit-fence produced. The
  // FS read/commit use `target.path`/`target.base`; the model-facing messages
  // keep `input.path` (the raw path the model typed). Absent worktree ⇒
  // `{ path: input.path, base: ctx.cwd }` (byte-identical legacy).
  target: { readonly path: string; readonly base: string },
): Promise<
  | { kind: "ready"; before: string; next: string; message: string }
  | { kind: "failure"; result: { ok: false; output: string; failure: ToolFailure } }
> => {
  const source = await fs.readFile(target.path, target.base)
  const preconditionFailure = checkHashPrecondition(source, input.path, input.expected_hash)
  if (preconditionFailure !== null) return { kind: "failure", result: preconditionFailure }
  // H12 — validate caller-supplied line ranges BEFORE matching. A malformed
  // range is a model error, surfaced as `rejected` so it fixes the span rather
  // than wondering why the edit "found nothing". Absent ⇒ undefined (whole-file
  // search, byte-identical legacy path).
  const rangesResolved = resolveLineRanges(input)
  if (!rangesResolved.ok) return { kind: "failure", result: rangesResolved.result }
  const lineRanges = rangesResolved.ranges
  const replaceAll = input.replace_all ?? false
  let result = applyExactEdit(source, input.old_string, input.new_string, replaceAll, lineRanges)
  if ((!result.ok || result.next === undefined) && input.fuzzy) {
    result = applyFuzzyEdit(source, input.old_string, input.new_string, replaceAll, lineRanges)
  }
  if (!result.ok || result.next === undefined) {
    // jun-7-misc 06 — OPTIONAL model-apply MERGE rung, AFTER the deterministic
    // exact/fuzzy ladder missed and BEFORE the typed mismatch (ticket §4.b: only
    // spend an apply-model call once the free rungs miss). Default-OFF: when
    // `ctx.fastApplyMerge` is unwired this is a single `undefined` check and the
    // path below is BYTE-IDENTICAL to the legacy mismatch. When wired, a verified
    // merge becomes the `ready` bytes that flow through the SAME gated commit +
    // diff-sink path as any edit — never a blind write.
    const merged = await tryFastApplyMergeRung(ctx, source, input, lineRanges)
    if (merged !== null) {
      return {
        kind: "ready",
        before: source,
        next: merged,
        message: "applied via fast-apply merge",
      }
    }
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
  // ticket-11 — resolved write target: `path` is the worktree-resolved path,
  // `base` is the SESSION jail root (absolute paths stay session-jailed; the
  // worktree never re-jails). Absent worktree ⇒ `{ input.path, ctx.cwd }`.
  target: { readonly path: string; readonly base: string },
  next: string,
  expectedHash: string | undefined,
): Promise<void> => {
  const cs = ctx.criticalSection?.begin()
  try {
    if (expectedHash !== undefined && fs.writeFileAtomic !== undefined) {
      await fs.writeFileAtomic(target.path, next, target.base)
      return
    }
    await fs.writeFile(target.path, next, target.base)
  } finally {
    cs?.end()
  }
}

/** Static pre-read denies for `edit` (BEFORE the read, never a partial write):
 *  ADR-0091 git-write-protection THEN jun-6 exfil-rail (b) glob-in-write. Both
 *  default-OFF (`null` ⇒ byte-identical). Extracted so `execute` stays under the
 *  biome cognitive-complexity cap. */
const editStaticDeny = (path: string, ctx: ToolContext): ToolEvent | null =>
  gitWriteGuardDeny(path, ctx) ?? globWriteGuardEvent(path, ctx)

/** Pre-commit denies for `edit` (AFTER planning, BEFORE commit): ADR-0474
 *  stale-read-guard THEN jun-6 exfil-rail (a) per-turn write-budget. Both
 *  default-OFF (`null` ⇒ byte-identical). Extracted so `execute` stays under the
 *  biome cognitive-complexity cap. */
const editPreCommitDeny = async (
  fs: FileSystemPort,
  ctx: ToolContext,
  // ticket-11 — resolved target (worktree-aware path + session jail base).
  target: { readonly path: string; readonly base: string },
): Promise<ToolEvent | null> => {
  if (ctx.readFileState !== undefined) {
    const cur = await fs.statFile(target.path, target.base)
    const guard = guardWrite(ctx.readFileState, cur.path, cur.mtimeMs)
    if (!guard.ok) {
      return {
        type: "result",
        result: {
          ok: false,
          output: guard.error.message,
          failure: { mode: "rejected", reason: "stale_read" },
        },
      }
    }
  }
  return writeBudgetEvent(ctx)
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
    // Static pre-read denies (git-write-protection + jun-6 glob-in-write guard).
    const staticDeny = editStaticDeny(input.path, ctx)
    if (staticDeny) {
      yield staticDeny
      return
    }
    // ticket-11 (P8 worktree edit-fence) — resolve the effective FS target. When
    // a session worktree is active, a RELATIVE path resolves against the worktree
    // dir; an ABSOLUTE path STILL jails to the SESSION root (the worktree is a
    // relative-cwd override, NOT a trust-boundary redefinition). Absent worktree ⇒
    // `{ path: input.path, base: ctx.cwd }` (byte-identical legacy). The
    // git-write/glob static denies above ran on `input.path` (the raw pattern the
    // model typed) — correct, those are path-shape matchers, not FS resolution.
    const target = resolveEditBase(input.path, ctx.cwd, ctx.activeWorktree)
    // Resolve relative paths against the session cwd, not process.cwd().
    // The jail check fires in readFile() (and again in writeFile()) BEFORE
    // any write, so a denied path is NEVER a partial write.
    try {
      const planned = await planEdit(fs, input, ctx, target)
      if (planned.kind === "failure") {
        yield { type: "result", result: planned.result }
        return
      }
      // ADR-0474 stale-read-guard + jun-6 exfil-rail (a) per-turn write-budget,
      // both AFTER planning and BEFORE the commit (a deny is never a partial
      // write). Default-OFF ⇒ `null` ⇒ byte-identical.
      const preCommitDeny = await editPreCommitDeny(fs, ctx, target)
      if (preCommitDeny) {
        yield preCommitDeny
        return
      }
      // jun-6 tool-interrupt-behavior — the commit runs inside the OPTIONAL
      // critical section (inside `commitEdit`) so an in-flight ESC cannot tear a
      // half-written file (no-op when the seam is unwired; byte-identical).
      await commitEdit(fs, ctx, target, planned.next, input.expected_hash)
      // ADR-0440 — feed the before/after to the optional tool-diff sink so the
      // web-daemon emits a `tool.diff` canvas frame. Default-OFF: no-op unless
      // `ctx.toolDiff` + `ctx.toolCallId` are both wired (gate ON). No recompute
      // (the daemon runs the diff once); the file is already written, so the
      // helper swallows any sink throw.
      captureToolDiff(ctx, planned.before, planned.next, input.path)
      // file_history_rewind — record the post-edit bytes as a per-file version.
      // No-op when the sink is unwired (gate OFF ⇒ byte-identical legacy path).
      captureFileHistory(ctx, input.path, planned.next)
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
