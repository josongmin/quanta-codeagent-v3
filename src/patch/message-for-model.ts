// messageForModel builder — typed-error → compact model-facing hint (ADR-0464).
//
// What this does: maps each typed patch error to a SHORT, actionable string the
// LLM can act on to re-emit JUST the failed file. Faithful to Cursor's
// `applied_changes[].message_for_model` field. Pure + total: every error kind
// — including the unknown/fallback case — produces a non-empty hint.
//
// Slices imported: `@/patch`'s own `./structured-types` (none — value-side we
// import only the typed errors from `./types`, which live in this same slice).
// We do NOT import `@/tool`'s `FsJailViolationError` (that would be an upward
// cross-slice import, forbidden by the fence) — a jail breach is recognised
// STRUCTURALLY (by its `name` + `attemptedPath`/`jailRoot` fields) so the
// builder stays pure within `@/patch`.
//
// NO-THROW contract: `messageForModel(err)` never throws for ANY input
// (including null/undefined/non-Error). It returns a string, always.

import { PatchAnchorNotFoundError, PatchApplyError, PatchParseError } from "./types"

/** Structural shape of a jail-boundary breach. `@/tool`'s `FsJailViolationError`
 *  cannot be imported here (upward dependency), so we duck-type it: a breach is
 *  any error whose `name` is `"FsJailViolationError"` and that carries the two
 *  fields the tool-layer class declares. This keeps the builder in-slice while
 *  still giving the model a boundary-specific hint. */
interface JailBreachLike {
  readonly name: string
  readonly attemptedPath: string
  readonly jailRoot: string
}

function isJailBreachLike(e: unknown): e is JailBreachLike {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "FsJailViolationError" &&
    typeof (e as { attemptedPath?: unknown }).attemptedPath === "string"
  )
}

/**
 * Build a compact, model-facing retry hint from a typed patch error.
 *
 * Deterministic mapping (no heuristics) — each branch keys off the concrete
 * error class / structural shape and surfaces ONLY what the model needs to
 * re-anchor the failing file:
 *
 *   - {@link PatchAnchorNotFoundError} → the file + hunk index + the applier's
 *     detail (which already states whether exact/whitespace matching failed).
 *     This is the most common self-correctable case: "your context drifted —
 *     re-read the file and regenerate the hunk with fresh surrounding lines."
 *   - {@link PatchApplyError} → the file (+ hunk when known) + the detail
 *     (ambiguous context / missing target / occupied move destination).
 *   - {@link PatchParseError} → grammar violation at a line; the patch text
 *     itself is malformed, so the hint tells the model to fix the V4A syntax.
 *   - jail-breach (structural) → a security boundary was hit; the model is told
 *     the path is outside the workspace and to target an in-workspace path.
 *   - anything else → a generic "apply failed" hint carrying the message, so a
 *     surprise error still yields an actionable (if coarse) retry instruction.
 *
 * The strings are intentionally terse and contain NO patch text / file content
 * / anchor lines — only the categorical failure + path + (when present) the
 * applier's own short detail. The model uses them to decide which file to
 * regenerate, not to reconstruct the diff.
 */
export function messageForModel(error: unknown): string {
  if (error instanceof PatchAnchorNotFoundError) {
    return `${error.path}: hunk ${error.hunkIndex} context not found — the surrounding lines have drifted; re-read the file and regenerate this hunk with current context lines.`
  }
  if (error instanceof PatchApplyError) {
    // The applier wraps a non-typed COMMIT-phase failure (an I/O / port error
    // surfaced AFTER pre-flight) as a `PatchApplyError` with an EMPTY path
    // (`applier.ts` — "Patch commit failed and was rolled back: …"). That is an
    // infrastructure failure, NOT a malformed hunk: telling the model to "fix
    // this file's hunk and re-emit" would be wrong advice (and the bare-colon
    // prefix would be malformed). Surface a distinct, honest hint instead.
    if (error.path.length === 0) {
      return `apply could not be committed and was rolled back: ${stripPrefix(error.message)} — the file is unchanged; this is not a patch-format error, retry the apply.`
    }
    const where =
      error.hunkIndex !== undefined ? `${error.path} (hunk ${error.hunkIndex})` : error.path
    return `${where}: ${stripPrefix(error.message)} — fix this file's hunk and re-emit just this file.`
  }
  if (error instanceof PatchParseError) {
    return `patch grammar error at line ${error.lineNumber}: ${stripPrefix(error.message)} — correct the V4A patch syntax and re-emit.`
  }
  if (isJailBreachLike(error)) {
    return `${error.attemptedPath}: resolves outside the workspace root — target a path inside the workspace and re-emit.`
  }
  return `apply failed: ${safeMessage(error)} — review and re-emit just the failing file.`
}

/** The typed errors prefix their `.message` with a redundant restatement
 *  (e.g. "Patch apply error on X: …"). For the model-facing hint we lead with
 *  the path ourselves, so strip a single leading "<...>: " segment when the
 *  underlying detail is what we want. Conservative: only strips a known
 *  prefix-then-colon form; otherwise returns the message untouched. */
function stripPrefix(message: string): string {
  const idx = message.indexOf(": ")
  if (idx <= 0) return message
  const head = message.slice(0, idx)
  // Only strip the applier's own framing, never arbitrary content that
  // happened to contain a colon.
  if (head.startsWith("Patch apply error on ") || head.startsWith("Patch parse error at line ")) {
    return message.slice(idx + 2)
  }
  return message
}

/** Extract a message from an arbitrary thrown value without ever throwing. */
function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return String(error)
  } catch {
    return "unknown error"
  }
}
