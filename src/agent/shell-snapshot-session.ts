/**
 * ADR-0235 — per-turn shell-snapshot wire helper (loop-side composition).
 *
 * Owns the per-session lifecycle of {@link AgentConfig.shellSnapshot}:
 *
 *   - `buildShellSnapshotSession(cfg)` returns a session-scoped object that
 *     exposes `snapshotForTurn(turn)` (called by the loop at turn-start) +
 *     `currentSeam()` (read by dispatch when wiring `ToolContext`).
 *   - Capture failures are swallowed (no-throw): the session's current
 *     handle stays `undefined` and `currentSeam()` returns `undefined` so
 *     the next dispatch falls back to the byte-identical legacy
 *     `runShell` path (no `source` prefix). The loop emits one
 *     `error` AgentEvent per failure so the surface can show the user.
 *   - Prune is best-effort and runs ONCE at session start.
 *
 * Default-OFF discipline (RFC §1.2): `cfg.shellSnapshot` absent ⇒ this
 * helper returns `undefined` and the loop is byte-identical for every
 * legacy caller. The `currentSeam()` method returns `undefined` whenever
 * capture has not produced a valid handle.
 *
 * Plane-clean: this module imports `@/runtime/shell-snapshot` (the slice
 * barrel — the public entry-point) for the port + handle types; it does
 * NOT reach into the slice internals.
 */

import type { SnapshotHandle } from "@/runtime/shell-snapshot"
import type { ShellSnapshotRestoreSeam } from "@/runtime/types"
import { errMessage } from "@/shared"
import type { AgentConfig } from "./types"

/** 10 days — the default retention window for `~/.quanta/shell_snapshots/`.
 *  Mirrors Codex's observed `logs_2.sqlite` window so a user with both
 *  agents on disk sees consistent retention semantics. */
export const DEFAULT_CLEANUP_OLDER_THAN_MS = 864e5 * 10

/** 100MB — soft cap on the snapshot directory size. Currently surfaced
 *  via the helper's typed config; enforcement is a follow-up (the prune
 *  call already sweeps by age, the byte-cap is a defense-in-depth knob). */
export const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024

/** Pure: `auto` ⇒ inspect `$SHELL` basename. `zsh` if `zsh`, else `bash`.
 *  Explicit `"zsh"` / `"bash"` pass through. Exported for unit tests. */
export const resolveShell = (
  mode: "auto" | "zsh" | "bash" | undefined,
  shellEnv: string | undefined,
): "zsh" | "bash" => {
  if (mode === "zsh" || mode === "bash") return mode
  // Defaulting `mode` to `"auto"` when undefined keeps the call site simple.
  const env = shellEnv ?? ""
  const base = env.split("/").pop() ?? env
  return base === "zsh" ? "zsh" : "bash"
}

/** The error reporter passed by the loop — a single function that emits
 *  one `error` AgentEvent. Kept narrow so this helper does not import
 *  `@/stream`. */
export type ShellSnapshotErrorEmitter = (message: string) => void

/** Pure: format a `SnapErr` tag with the kind-specific detail (when
 *  available). Defense-in-depth: never leaks the raw `path` on
 *  `write-failed`; only the adapter-supplied `detail` string is surfaced.
 *  Exported for unit-test coverage. */
export const formatSnapErrDetail = (err: {
  readonly kind: string
  readonly detail?: string
  readonly raw?: string
  readonly timeoutMs?: number
}): string => {
  if (err.kind === "shell-missing") {
    return err.detail !== undefined ? ` (${err.detail})` : ""
  }
  if (err.kind === "write-failed") {
    return err.detail !== undefined ? ` (${err.detail})` : ""
  }
  if (err.kind === "invalid-id") {
    return ` (raw=${err.raw ?? ""})`
  }
  if (err.kind === "capture-timeout") {
    return ` (${err.timeoutMs ?? 0}ms)`
  }
  return ""
}

/** Per-session handle exposed to the loop + dispatch. */
export interface ShellSnapshotSession {
  /** Called at turn-start by the loop (when `captureAtTurnStart === true`)
   *  OR once per session (when `false`). Captures a fresh snapshot; on
   *  failure leaves the current handle intact and emits via the supplied
   *  error reporter. No-throw. */
  snapshotForTurn(turn: number): Promise<void>
  /** Read by the dispatch seam when constructing `ToolContext`. Returns
   *  the restore seam (handle + restore fn) when a valid snapshot exists,
   *  else `undefined` so the seam is omitted under
   *  `exactOptionalPropertyTypes`. */
  currentSeam(): ShellSnapshotRestoreSeam | undefined
  /** Operational: invoked once at session start to drop stale snapshot
   *  files. Best-effort; failures collapse to an `error` AgentEvent. */
  pruneOnStart(): Promise<void>
}

/** Build the session helper. Returns `undefined` when `cfg.shellSnapshot`
 *  is absent so the loop short-circuits with zero allocation (default-OFF
 *  byte-identical, RFC §1.2). */
export const buildShellSnapshotSession = (
  cfg: AgentConfig,
  emitError: ShellSnapshotErrorEmitter,
  // Slice invariant (ADR-0144): no process.env in @/agent. Caller resolves
  // SHELL at composition root (apps/cli) and passes — absent ⇒ resolveShell
  // uses /bin/bash fallback. Default-OFF behavior unchanged.
  shellEnv: string | undefined = undefined,
): ShellSnapshotSession | undefined => {
  const config = cfg.shellSnapshot
  if (config === undefined) return undefined

  const { port } = config
  const shell = resolveShell(config.shell, shellEnv)
  const captureAtTurnStart = config.captureAtTurnStart ?? true
  const cleanupOlderThanMs = config.cleanupOlderThanMs ?? DEFAULT_CLEANUP_OLDER_THAN_MS
  // ADR-0237 — the byte-cap is consulted at session-start prune AFTER the
  // age-based sweep. Two-phase prune: (1) cheap age-based delete, then
  // (2) size-cap eviction of whatever survived. Either failure emits one
  // `error` AgentEvent — the loop continues regardless (no-throw boundary).
  const maxSizeBytes = config.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES

  // Mutable per-session handle slot. `undefined` means "no valid snapshot
  // available right now" — `currentSeam()` returns `undefined` so dispatch
  // omits the field on `ToolContext` (exactOptionalPropertyTypes-safe).
  // Stored as the FULL `SnapshotHandle` so `port.restore` receives every
  // field it depends on (`capturedAtMs` / `shell`), not a stub.
  let current: SnapshotHandle | undefined
  // Tracks whether a one-shot capture has fired (used when captureAtTurnStart
  // is false). Without this, every turn would re-capture even in the
  // explicit opt-out mode.
  let oneShotDone = false

  const doCapture = async (turn: number): Promise<void> => {
    try {
      const result = await port.capture({ shell, id: `turn-${turn}` })
      if (!result.ok) {
        // Best-effort error reporting: the surface (CLI / IDE) shows ONE
        // line per failure; subsequent runShell calls in the same turn
        // proceed without a snapshot prefix (byte-identical legacy spawn).
        const errObj = result.error
        emitError(`shell-snapshot capture failed: ${errObj.kind}${formatSnapErrDetail(errObj)}`)
        return
      }
      current = result.value
    } catch (e) {
      // Defense-in-depth: the port's contract is no-throw, but a hostile
      // adapter that throws must not crash the turn.
      emitError(`shell-snapshot capture threw: ${errMessage(e)}`)
    }
  }

  return {
    async snapshotForTurn(turn: number): Promise<void> {
      if (!captureAtTurnStart) {
        if (oneShotDone) return
        oneShotDone = true
      }
      await doCapture(turn)
    },
    currentSeam(): ShellSnapshotRestoreSeam | undefined {
      const handle = current
      if (handle === undefined) return undefined
      // Capture the full handle in a const so the closure doesn't observe
      // a later mutation of `current` (next-turn re-capture). The runtime
      // seam only reads `handle.id` / `handle.path`; the closure feeds the
      // FULL handle into `port.restore` so the slice contract is honoured.
      const captured = handle
      return {
        handle: { id: captured.id, path: captured.path },
        restore: (_h, prefix) => port.restore(captured, prefix),
      }
    },
    async pruneOnStart(): Promise<void> {
      // Two-phase prune (ADR-0237). Age first so the size sweep operates
      // on a (typically) smaller set. Each phase's failure is reported but
      // does NOT abort the other — partial cleanup is better than none.
      try {
        await port.prune(cleanupOlderThanMs)
      } catch (e) {
        emitError(`shell-snapshot prune failed: ${errMessage(e)}`)
      }
      try {
        await port.pruneToSizeBudget(maxSizeBytes)
      } catch (e) {
        emitError(`shell-snapshot size-prune failed: ${errMessage(e)}`)
      }
    },
  }
}
