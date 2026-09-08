// Inverse-journal rollback for the V4A applier.
// Inverse actions are registered BEFORE the mutating call they undo (F5).
// Undo failures are collected, never swallowed, and never claimed as a
// clean restore.

import { errMessage } from "@/shared"
import {
  PatchAnchorNotFoundError,
  PatchApplyError,
  PatchRollbackIncompleteError,
  type UndoFailure,
} from "./types"

/** One journaled inverse. `paths` are the on-disk locations that undo touches. */
export type InverseAction = {
  readonly paths: readonly string[]
  readonly undo: () => Promise<void>
}

/** Replay newest-first. Returns every inverse that threw; remaining entries still run. */
export async function rollback(journal: readonly InverseAction[]): Promise<UndoFailure[]> {
  const failures: UndoFailure[] = []
  for (let i = journal.length - 1; i >= 0; i--) {
    const entry = journal[i]
    if (entry === undefined) continue
    try {
      await entry.undo()
    } catch (cause) {
      const msg = errMessage(cause)
      for (const path of entry.paths) {
        failures.push({ path, cause: msg })
      }
    }
  }
  return failures
}

/**
 * Map a commit-phase throw + undo report to the caller-facing error.
 * `rolledBack` (every required undo succeeded) keeps the historical
 * empty-path {@link PatchApplyError} so "the file is unchanged" is allowed.
 * Any undo failure is {@link PatchRollbackIncompleteError} — never "unchanged".
 */
export function rethrowCommitFailure(
  original: unknown,
  failedUndos: readonly UndoFailure[],
): never {
  if (failedUndos.length > 0) {
    throw new PatchRollbackIncompleteError(original, failedUndos)
  }
  if (original instanceof PatchApplyError || original instanceof PatchAnchorNotFoundError) {
    throw original
  }
  throw new PatchApplyError(`Patch commit failed and was rolled back: ${errMessage(original)}`, "")
}
