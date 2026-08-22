/**
 * ADR-0204 — bash adapter for shell-snapshot.
 *
 * Spawns `bash -i -c "declare -p; declare -f; alias"`. The aliasing
 * order differs from zsh (`alias` last) because bash's `declare -f`
 * already lists functions independently — putting `alias` last
 * matches what an interactive bash user sees on completion.
 *
 * See `zsh-capture.ts` for the shared `SnapshotSpawner` contract.
 */

import { homedir } from "node:os"
import { err, ok, type Result } from "@/shared"
import { mkId, writeSnapshot } from "./file-store"
import type { SnapErr, SnapshotHandle } from "./types"
import {
  type CaptureRunOptions,
  DEFAULT_CAPTURE_TIMEOUT_MS,
  type SnapshotSpawner,
} from "./zsh-capture"

export const captureBash = async (
  spawner: SnapshotSpawner,
  opts: CaptureRunOptions = {},
): Promise<Result<SnapshotHandle, SnapErr>> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
  const id = mkId(opts.seed)
  if (id === null) {
    return err({ kind: "invalid-id", raw: opts.seed ?? "" })
  }

  const argv = ["bash", "-i", "-c", "declare -p; declare -f; alias"] as const
  const result = await spawner.run(argv, { timeoutMs })

  if (result.spawnFailed === true || result.code === null) {
    return err({
      kind: "shell-missing",
      shell: "bash",
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    })
  }
  if (result.timedOut) {
    return err({ kind: "capture-timeout", shell: "bash", timeoutMs })
  }
  if (result.stdout.trim().length === 0) {
    return err({ kind: "empty-capture", shell: "bash" })
  }

  const home = opts.home ?? homedir()
  const write = await writeSnapshot(id, result.stdout, "bash", home)
  if (!write.ok) return err(write.err)
  return ok({ id, path: write.path, capturedAtMs: Date.now(), shell: "bash" })
}
