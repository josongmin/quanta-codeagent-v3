/**
 * Stale-read-guard slice — public surface (ADR-0474).
 *
 * WHAT: a default-OFF guard that tracks read-time file mtimes, blocks a
 * write/edit whose target was externally modified since the read (with a
 * "re-read first" message), and renders a post-bash reminder listing read files
 * a build/format command just rewrote.
 *
 * ADR: ADR-0474.
 * Slices imported (transitively): `@/shared` ONLY. The real mtime is injected by
 * the host (FileSystemPort at integration); this slice is unit-testable with
 * hand-fed mtimes.
 * NO-THROW: every export returns a value, never throws.
 * DEFAULT-OFF: gate `staleReadGuardEnabled(env)` — host checks it before use.
 */

export { STALE_READ_GUARD_ENV, staleReadGuardEnabled } from "./gate"
export { isWriteCommand, WRITE_COMMAND_MARKERS } from "./markers"
export { renderStaleReminder } from "./reminder"
export {
  DEFAULT_RANGE_DEDUP_CAP,
  guardWrite,
  type MtimeObservation,
  ReadFileState,
  staleAfterBash,
} from "./state"
export {
  type Freshness,
  type FreshnessKind,
  STALE_WRITE_MESSAGE,
  StaleReadError,
} from "./types"
