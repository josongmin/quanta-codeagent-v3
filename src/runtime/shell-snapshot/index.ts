/**
 * ADR-0204 — barrel.
 *
 * Public entry-point for the shell-snapshot slice. Composition roots
 * should import from here; downstream slice files (zsh-capture,
 * bash-capture, file-store) stay internal.
 */

import { homedir } from "node:os"
import type { Result } from "@/shared"
import { captureBash } from "./bash-capture"
import { prune as fsPrune, pruneToSizeBudget as fsPruneToSize } from "./file-store"
import type { CaptureOptions, ShellSnapshotPort } from "./port"
import type { RestoreDegradeReason, RestoreOutcome, SnapErr, SnapshotHandle } from "./types"
import { captureZsh, type SnapshotSpawner } from "./zsh-capture"

export {
  createBunSpawner,
  DEFAULT_BUN_SPAWNER_TIMEOUT_MS,
  type BunSpawnerOptions,
} from "./bun-spawner"
export { pruneToSizeBudget } from "./file-store"
export { headlessSpawner, headlessStubBody } from "./headless-stub"
export type { CaptureOptions, ShellSnapshotPort } from "./port"
export type {
  RestoreDegradeReason,
  RestoreOutcome,
  SnapErr,
  SnapshotHandle,
  SupportedShell,
} from "./types"
export type { SnapshotSpawner } from "./zsh-capture"

const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "dash", "ksh"])

/** Pure: is this argv shaped like `<some-shell> -c <cmd>`? */
const isShellDashCPrefix = (
  prefix: ReadonlyArray<string>,
):
  | { kind: "ok"; shell: string; cmdIndex: number }
  | { kind: "skip"; reason: RestoreDegradeReason } => {
  if (prefix.length === 0) return { kind: "skip", reason: "empty-prefix" }
  const head = prefix[0]
  if (head === undefined) return { kind: "skip", reason: "empty-prefix" }
  const base = head.split("/").pop() ?? head
  if (!SHELL_BINARIES.has(base)) return { kind: "skip", reason: "non-shell-prefix" }
  // Accept `-c` OR `-lc` (the legacy `runShell` form). Both end with `c`
  // and are followed by exactly one command-string argument.
  const cFlagIdx = prefix.findIndex((a, i) => i > 0 && (a === "-c" || a === "-lc" || a === "-ic"))
  if (cFlagIdx === -1) return { kind: "skip", reason: "missing-c-flag" }
  const cmdIndex = cFlagIdx + 1
  if (cmdIndex >= prefix.length) return { kind: "skip", reason: "missing-c-flag" }
  return { kind: "ok", shell: head, cmdIndex }
}

/** Pure: build the augmented argv. Does NOT touch the filesystem. */
export const buildRestoredArgv = (
  handle: SnapshotHandle,
  prefix: ReadonlyArray<string>,
): RestoreOutcome => {
  const parsed = isShellDashCPrefix(prefix)
  if (parsed.kind === "skip") {
    return { argv: [...prefix], degradeReason: parsed.reason }
  }
  const out = [...prefix]
  const original = out[parsed.cmdIndex] ?? ""
  // Single-quote the path is unsafe (would break on `'` in HOME) — the
  // path lives under HOME and we sanitised the id, so direct
  // interpolation is safe; defense-in-depth, we still wrap the source
  // command in braces so it cannot fuse with the user command.
  out[parsed.cmdIndex] = `source ${handle.path}; ${original}`
  return { argv: out }
}

/** Default production port. Uses real `Bun.spawn` via the supplied
 *  spawner — caller injects so the port stays testable. */
export const createShellSnapshotPort = (
  spawner: SnapshotSpawner,
  home: string = homedir(),
): ShellSnapshotPort => ({
  async capture(opts: CaptureOptions): Promise<Result<SnapshotHandle, SnapErr>> {
    const captureFn = opts.shell === "zsh" ? captureZsh : captureBash
    return captureFn(spawner, {
      ...(opts.id !== undefined ? { seed: opts.id } : {}),
      home,
    })
  },
  restore(handle: SnapshotHandle, prefix: ReadonlyArray<string>): RestoreOutcome {
    return buildRestoredArgv(handle, prefix)
  },
  async prune(olderThanMs: number): Promise<number> {
    return fsPrune(olderThanMs, home)
  },
  async pruneToSizeBudget(maxBytes: number): Promise<number> {
    return fsPruneToSize(maxBytes, home)
  },
})
