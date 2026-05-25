/**
 * ADR-0204 — types for the per-turn shell snapshot primitive.
 *
 * `SnapshotHandle` is the value the caller persists between `capture` and
 * `restore`. `SnapErr` is a closed-union failure code so policy code can
 * branch on `.kind` without parsing error messages (project convention —
 * see src/shared/errors.ts).
 */

/** Supported login-shell capture adapters. */
export type SupportedShell = "zsh" | "bash"

/** Persisted snapshot reference. The `path` lives under
 *  `~/.quanta/shell_snapshots/` and is sourced by the spawned shell at
 *  command-execution time. */
export interface SnapshotHandle {
  /** Sanitised, filesystem-safe id (NOT the absolute path). */
  readonly id: string
  /** Absolute path to the persisted `.sh` file. */
  readonly path: string
  /** `Date.now()` at the moment `capture()` resolved. */
  readonly capturedAtMs: number
  /** The shell that produced this snapshot. */
  readonly shell: SupportedShell
}

/** Closed-union snapshot failure code. */
export type SnapErr =
  | { kind: "shell-missing"; shell: SupportedShell; detail?: string }
  | { kind: "empty-capture"; shell: SupportedShell }
  | { kind: "capture-timeout"; shell: SupportedShell; timeoutMs: number }
  | { kind: "write-failed"; shell: SupportedShell; detail: string }
  | { kind: "invalid-id"; raw: string }

/** Reason for a `restore` call that could not be honoured. The caller can
 *  log/emit this through its existing observability channel — `restore`
 *  itself stays argv-shaped. */
export type RestoreDegradeReason =
  | "non-shell-prefix"
  | "empty-prefix"
  | "missing-c-flag"

/** Result of a `restore` call. The function ALWAYS returns an argv; when
 *  the prefix could not be augmented, `degradeReason` is set and `argv`
 *  is a shallow copy of the input (the input array is never mutated). */
export interface RestoreOutcome {
  readonly argv: string[]
  readonly degradeReason?: RestoreDegradeReason
}
