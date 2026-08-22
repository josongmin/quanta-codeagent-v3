/**
 * ADR-0204 — zsh adapter for shell-snapshot.
 *
 * Spawns `zsh -i -c "typeset -p; alias; declare -f"` (zsh's correct
 * dump ordering — `typeset -p` first so subsequent `declare -f` does
 * not shadow). Output is captured to memory and persisted via
 * `writeSnapshot`. The default 10s timeout caps a hung rc-file.
 *
 * `Spawner` is injected so the hellgate can drive failure modes
 * (missing binary / empty output / hang / non-zero exit) without
 * touching the host shell.
 */

import { homedir } from "node:os"
import { err, ok, type Result } from "@/shared"
import { mkId, writeSnapshot } from "./file-store"
import type { SnapErr, SnapshotHandle } from "./types"

export const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000

/** Test-injected spawn surface — keeps `Bun.spawn` out of unit tests. */
export interface SnapshotSpawner {
  run(
    argv: ReadonlyArray<string>,
    opts: { timeoutMs: number },
  ): Promise<{
    /** Process exit code; `null` when the spawn could not even start
     *  (binary missing). */
    code: number | null
    stdout: string
    /** `true` when the run exceeded `opts.timeoutMs`. */
    timedOut: boolean
    /** `true` when the binary itself was not found (`ENOENT`). */
    spawnFailed?: boolean
    /** Free-form detail for `shell-missing` / spawn errors. */
    detail?: string
  }>
}

export interface CaptureRunOptions {
  readonly seed?: string
  readonly timeoutMs?: number
  /** Override HOME for tests. */
  readonly home?: string
}

/** Run the zsh dump. Returns a SnapshotHandle on success. */
export const captureZsh = async (
  spawner: SnapshotSpawner,
  opts: CaptureRunOptions = {},
): Promise<Result<SnapshotHandle, SnapErr>> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
  const id = mkId(opts.seed)
  if (id === null) {
    return err({ kind: "invalid-id", raw: opts.seed ?? "" })
  }

  const argv = ["zsh", "-i", "-c", "typeset -p; alias; declare -f"] as const
  const result = await spawner.run(argv, { timeoutMs })

  if (result.spawnFailed === true || result.code === null) {
    return err({
      kind: "shell-missing",
      shell: "zsh",
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    })
  }
  if (result.timedOut) {
    return err({ kind: "capture-timeout", shell: "zsh", timeoutMs })
  }
  if (result.stdout.trim().length === 0) {
    return err({ kind: "empty-capture", shell: "zsh" })
  }

  const home = opts.home ?? homedir()
  const write = await writeSnapshot(id, result.stdout, "zsh", home)
  if (!write.ok) return err(write.err)
  return ok({ id, path: write.path, capturedAtMs: Date.now(), shell: "zsh" })
}
