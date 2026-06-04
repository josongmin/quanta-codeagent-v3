// Structured per-file apply — self-correcting edits (ADR-0464).
//
// What this does: `applyPatchStructured(patch, fs)` applies a parsed V4A patch
// op-by-op with PER-FILE ISOLATION and returns a `Result<StructuredApplyOutcome>`
// — one `AppliedChange` per op (success or failure, in patch order) plus an
// `allOk` flag. One file's failing hunk does NOT prevent the other files from
// applying; the failed file's prior on-disk content is left intact (no partial
// write of THAT file — guaranteed by the existing applier's atomic per-op
// plan/commit/rollback). This is the additive, default-OFF counterpart to the
// canonical `applyPatch` (`./applier`), which still throws wholesale.
//
// Faithful to Cursor's `ApplyAgentDiff`: instead of aborting the whole patch on
// the first bad hunk, return a structured per-file outcome so the LLM can
// self-correct only the failed file via `messageForModel`.
//
// Slices imported: `@/shared` (Result/ok/err) + this slice's own modules
// (`./applier` for the atomic single-op apply, `./types` for the op union +
// port, `./structured-types` for the result shape, `./message-for-model` for
// the model-facing hint). NO upward imports — stays pure within `@/patch`,
// driven by the injected `PatchFileSystemPort`.
//
// NO-THROW contract: returns `Result<StructuredApplyOutcome>`. A programmer-bug
// input (non-object patch, missing ops array) is encoded as `err(...)`, never
// thrown. A misbehaving port whose method rejects is captured as a per-file
// failure (that op's `AppliedChange` carries the error) and does NOT abort the
// other ops; it never propagates past the boundary.

import { err, errMessage, ok, type Result } from "@/shared"
import { applyPatch } from "./applier"
import { messageForModel } from "./message-for-model"
import type { AppliedChange, ApplyChangeType, StructuredApplyOutcome } from "./structured-types"
import type { Patch, PatchFileSystemPort, PatchOp } from "./types"

export { messageForModel } from "./message-for-model"
export type { AppliedChange, ApplyChangeType, StructuredApplyOutcome } from "./structured-types"

/**
 * Apply a parsed V4A patch op-by-op with per-file isolation, returning a
 * structured outcome instead of throwing on the first bad hunk.
 *
 * Algorithm (deterministic, no heuristics):
 *   1. Validate the input shape (no-throw guard) — a non-`Patch` value is an
 *      `err`, not an exception.
 *   2. For each op IN PATCH ORDER:
 *      a. Snapshot `beforeContent` by reading the op's source path (best-effort:
 *         a `created` op or an unreadable target yields `undefined` before).
 *      b. Apply that ONE op in isolation by delegating to the canonical
 *         `applyPatch` with a single-op `Patch`. This reuses the EXACT same
 *         locator, fuzzy tiers, pre-flight validation, and atomic
 *         plan/commit/rollback — so a single op either fully lands or leaves
 *         its file untouched. No locator logic is duplicated here.
 *      c. On success: capture `afterContent` (read back, except for delete) and
 *         push a success `AppliedChange`.
 *      d. On the typed error: push a FAILURE `AppliedChange` carrying the
 *         error message + `messageForModel(...)`. Prior on-disk content is
 *         intact (the single-op apply rolled itself back). Continue to next op.
 *   3. `allOk` is `true` iff every op succeeded.
 *
 * Per-file isolation is the whole point: file B applies even when file A's
 * hunk could not be anchored. Because each op is committed independently, an
 * EARLIER op that succeeded stays applied even if a LATER op fails — this is
 * the documented departure from `applyPatch`'s all-or-nothing-across-the-patch
 * contract, and is exactly Cursor's `applied_changes[]` (partial) shape.
 */
export async function applyPatchStructured(
  patch: Patch,
  fs: PatchFileSystemPort,
): Promise<Result<StructuredApplyOutcome>> {
  if (!isPatchShape(patch)) {
    return err(new Error("applyPatchStructured: argument is not a parsed Patch (missing ops[])"))
  }

  const appliedChanges: AppliedChange[] = []
  for (const op of patch.ops) {
    appliedChanges.push(await applyOneOp(op, fs))
  }

  const allOk = appliedChanges.every((c) => c.error === undefined)
  return ok({ appliedChanges, allOk })
}

/** Apply exactly one op in isolation, capturing before/after and converting a
 *  typed failure into a per-file `AppliedChange`. Never throws. */
async function applyOneOp(op: PatchOp, fs: PatchFileSystemPort): Promise<AppliedChange> {
  const changeType = changeTypeOf(op)
  const movedTo = op.kind === "update" && op.moveTo !== undefined ? op.moveTo : undefined

  // Snapshot the pre-apply content. A `created` op has no prior file; for the
  // others read best-effort (an unreadable/absent target ⇒ undefined before,
  // which is itself information the model can use).
  const beforeContent = op.kind === "add" ? undefined : await tryRead(fs, op.path)

  let applyError: unknown
  try {
    // Delegate to the canonical atomic applier with a SINGLE-op patch. This
    // reuses all locator + pre-flight + rollback logic; a failure here leaves
    // this op's file(s) untouched (the applier rolls its own journal back).
    await applyPatch({ ops: [op] }, fs)
  } catch (e) {
    applyError = e
  }

  if (applyError !== undefined) {
    // FAILURE: prior content is intact; no after. Carry the typed message +
    // the compact model-facing retry hint.
    return buildFailure(op.path, changeType, movedTo, beforeContent, applyError)
  }

  // SUCCESS: capture the resulting content. A delete has no after; a move's
  // result lives at the destination path.
  const afterContent = changeType === "deleted" ? undefined : await tryRead(fs, movedTo ?? op.path)

  return buildSuccess(op.path, changeType, movedTo, beforeContent, afterContent)
}

function buildSuccess(
  path: string,
  changeType: ApplyChangeType,
  movedTo: string | undefined,
  beforeContent: string | undefined,
  afterContent: string | undefined,
): AppliedChange {
  return {
    path,
    changeType,
    ...(movedTo !== undefined ? { movedTo } : {}),
    ...(beforeContent !== undefined ? { beforeContent } : {}),
    ...(afterContent !== undefined ? { afterContent } : {}),
  }
}

function buildFailure(
  path: string,
  changeType: ApplyChangeType,
  movedTo: string | undefined,
  beforeContent: string | undefined,
  error: unknown,
): AppliedChange {
  const message = errMessage(error)
  return {
    path,
    changeType,
    ...(movedTo !== undefined ? { movedTo } : {}),
    ...(beforeContent !== undefined ? { beforeContent } : {}),
    error: message,
    messageForModel: messageForModel(error),
  }
}

/** Map a V4A op to its Cursor `change_type`. A `*** Move to:` update is still a
 *  `"modified"` file at its new location (the rename is an edit + relocation;
 *  the model only needs to know the resulting file exists with new content). */
function changeTypeOf(op: PatchOp): ApplyChangeType {
  switch (op.kind) {
    case "add":
      return "created"
    case "delete":
      return "deleted"
    case "update":
      return "modified"
  }
}

/** Read a file via the port without ever throwing — a rejecting/absent read
 *  yields `undefined`. Used for best-effort before/after snapshots. */
async function tryRead(fs: PatchFileSystemPort, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path)
  } catch {
    return undefined
  }
}

/** Structural guard: a value is a usable `Patch` iff it has an `ops` array.
 *  Keeps `applyPatchStructured` no-throw for programmer-bug inputs. */
function isPatchShape(patch: unknown): patch is Patch {
  return (
    typeof patch === "object" && patch !== null && Array.isArray((patch as { ops?: unknown }).ops)
  )
}
