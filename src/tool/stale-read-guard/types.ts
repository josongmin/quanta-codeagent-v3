/**
 * Stale-read-guard slice — types + named constants (ADR-0474).
 *
 * WHAT: pure SSOT for the stale-read guard. Tracks the on-disk mtime each file
 * carried at the moment the agent last READ it, then lets a write/edit be
 * blocked when the target was externally modified since that read, and lets a
 * post-bash diff surface a "these read files are now stale" reminder.
 *
 * ADR: ADR-0474.
 *
 * Slices imported: `@/shared` ONLY (Result/ok/err + the untrusted embedder for
 * the reminder renderer). NO `@/storage`, NO `@/tool` siblings — the real mtime
 * is supplied by the host via an injected number (FileSystemPort at integration),
 * so this module is exercisable in isolation with hand-fed mtimes.
 *
 * NO-THROW contract: every export returns a value (Result / boolean / array /
 * string), never throws.
 *
 * DEFAULT-OFF: the gate `staleReadGuardEnabled(env)` returns false unless
 * `QUANTA_STALE_READ_GUARD === "1"`. The host consults the gate BEFORE calling
 * any guard function, so an unset deployment is byte-identical to today.
 */

/** A file's freshness verdict relative to the recorded read-time mtime. */
export type FreshnessKind = "fresh" | "stale" | "unread"

/** Result of {@link ReadFileState.checkFresh}. `unread` ⇒ the file was never
 *  read in this session, so the guard has no baseline and cannot claim it is
 *  stale (it lets the write proceed; "can't be stale if never read"). */
export type Freshness =
  | { readonly kind: "fresh" }
  | { readonly kind: "unread" }
  | { readonly kind: "stale"; readonly recordedMtimeMs: number; readonly currentMtimeMs: number }

/** The single error surface for a blocked write/edit. Carried in a `Result`'s
 *  `err()` — never thrown (NO-THROW). The `reason` is rendered for the model so
 *  it knows to re-read the file before retrying the mutation. */
export class StaleReadError extends Error {
  public readonly path: string
  public readonly recordedMtimeMs: number
  public readonly currentMtimeMs: number
  constructor(path: string, recordedMtimeMs: number, currentMtimeMs: number) {
    super(STALE_WRITE_MESSAGE(path))
    this.name = "StaleReadError"
    this.path = path
    this.recordedMtimeMs = recordedMtimeMs
    this.currentMtimeMs = currentMtimeMs
  }
}

/**
 * The verbatim "re-read first" guidance shown to the model when a write/edit is
 * blocked. Mirrors the Claude/Codex stale-write convention: name the file and
 * command the corrective action (re-read) so the model self-heals instead of
 * blindly retrying. NOT a heuristic — it is the fixed user-facing contract the
 * hellgate pins.
 */
export const STALE_WRITE_MESSAGE = (path: string): string =>
  `File '${path}' was modified on disk after you last read it. ` +
  `Your edit was NOT applied (it would clobber the external change). ` +
  `Re-read the file with the read tool, then re-apply your change against the current contents.`
