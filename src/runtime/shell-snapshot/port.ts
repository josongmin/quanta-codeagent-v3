/**
 * ADR-0204 — closed port for shell-snapshot.
 *
 * Two operations, mirroring Codex's `~/.codex/shell_snapshots/` pattern:
 *   - `capture` persists the active shell's env (params/aliases/functions)
 *     to a file and returns a handle.
 *   - `restore` augments a spawn argv so the user command runs with that
 *     file `source`d.
 *
 * The split-port keeps the two halves independently substitutable:
 *   - in production we wire `ZshCaptureAdapter` / `BashCaptureAdapter`,
 *   - in tests we wire `headlessStub()` for determinism.
 */

import type { Result } from "@/shared"
import type { RestoreOutcome, SnapErr, SnapshotHandle, SupportedShell } from "./types"

/** Caller options for `capture`. The shell is REQUIRED so the adapter
 *  knows which dump syntax to invoke (`zsh` and `bash` differ). */
export interface CaptureOptions {
  readonly shell: SupportedShell
  /** Optional override for the persisted id. When omitted the port
   *  generates a nonce-suffixed id. Always sanitised before use. */
  readonly id?: string
}

/** Top-level port — capture + restore + (operational) prune. */
export interface ShellSnapshotPort {
  capture(opts: CaptureOptions): Promise<Result<SnapshotHandle, SnapErr>>
  /** Returns a NEW argv (input is never mutated). When the prefix is a
   *  `*sh -c <cmd>` form, the returned argv is
   *    `[shell, "-c", "source ${path}; ${cmd}"]`.
   *  Otherwise the original argv is returned with `degradeReason` set. */
  restore(handle: SnapshotHandle, prefix: ReadonlyArray<string>): RestoreOutcome
  /** Drop snapshot files older than the cutoff. Returns the number of
   *  files removed. Default-safe — caller decides retention policy. */
  prune(olderThanMs: number): Promise<number>
}
