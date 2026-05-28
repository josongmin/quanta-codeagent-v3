// ADR-0421 — fast-apply fallback wire helpers for the `apply_patch` tool.
//
// Pure functions that classify a V4A apply failure into the closed
// `FastApplyFallbackSeam` failure shape and pull the target file path off the
// typed error. Kept in a sibling module so `apply-patch.ts` stays focused on
// the parse → apply → (optional retry) control flow and these classifiers can
// be unit-tested in isolation. NO I/O here — the consumer reads the source
// snapshot through the already-constructed `PatchFileSystemPort`.

import { PatchAnchorNotFoundError, PatchApplyError, PatchParseError } from "@/patch"
import type { FastApplyFailureKind } from "./types"

/**
 * Map a thrown V4A error to the closed `errorKind` the fallback port expects,
 * or `null` when the error is NOT a fast-apply-recoverable failure.
 *
 * Recoverable (the model can re-emit a better patch):
 *   - PatchAnchorNotFoundError ⇒ "anchor_not_found"
 *   - PatchApplyError          ⇒ "apply_error"
 *   - PatchParseError          ⇒ "parse_error"
 *
 * NOT recoverable (fallback is never attempted — these surface immediately):
 *   - FsJailViolationError and any non-patch error: a re-emitted patch cannot
 *     escape a SECURITY boundary, so we never spend a side-conversation on it.
 */
export const classifyFastApplyError = (err: unknown): FastApplyFailureKind | null => {
  if (err instanceof PatchAnchorNotFoundError) return "anchor_not_found"
  // Order matters only for readability — the three patch classes are disjoint.
  if (err instanceof PatchApplyError) return "apply_error"
  if (err instanceof PatchParseError) return "parse_error"
  return null
}

/**
 * Pull the target file path off a typed apply failure so the consumer can read
 * its current bytes (re-anchoring context for the model). Anchor + apply errors
 * carry `.path`; a parse error fails before any op is bound to a file, so it
 * has no target ⇒ `undefined` (the fallback prompt then omits the snapshot).
 */
export const failingTargetPath = (err: unknown): string | undefined => {
  if (err instanceof PatchAnchorNotFoundError) return err.path
  if (err instanceof PatchApplyError) return err.path
  return undefined
}
