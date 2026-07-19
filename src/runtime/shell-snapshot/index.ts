/**
 * ADR-0204 — barrel.
 *
 * Public entry-point for the shell-snapshot slice. Composition roots
 * should import from here; downstream slice files (zsh-capture,
 * bash-capture, file-store) stay internal.
 */

import { statSync } from "node:fs"
import { homedir } from "node:os"
import type { Result } from "@/shared"
import { captureBash } from "./bash-capture"
import { prune as fsPrune, pruneToSizeBudget as fsPruneToSize } from "./file-store"
import type { ShellSnapshotMetric } from "./metric-port"
import type { CaptureOptions, ShellSnapshotPort } from "./port"
import type { RestoreDegradeReason, RestoreOutcome, SnapErr, SnapshotHandle } from "./types"
import { captureZsh, type SnapshotSpawner } from "./zsh-capture"

export {
  type BunSpawnerOptions,
  createBunSpawner,
  DEFAULT_BUN_SPAWNER_TIMEOUT_MS,
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

/** Quote one shell word without relying on the caller's shell options. */
const quoteShellWord = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

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
  // Snapshot paths can contain spaces or apostrophes (for example under a
  // user-controlled HOME), so source a POSIX-quoted word rather than
  // interpolating the path into the command string.
  out[parsed.cmdIndex] = `source ${quoteShellWord(handle.path)}; ${original}`
  return { argv: out }
}

/** Optional creation overrides for {@link createShellSnapshotPort}. */
export interface CreateShellSnapshotPortOpts {
  /** Override `homedir()`. Tests use a tmpdir. */
  readonly home?: string
  /** ADR-0222 — optional metric port. When wired, each successful
   *  `capture()` records duration + byte size via `metric.recordCapture`.
   *  Absent ⇒ no allocation, no observation — byte-identical to legacy
   *  (RFC §1.2 default-OFF). Failure paths do NOT emit (the metric tracks
   *  successful captures only; misses surface via the slice's no-op metric
   *  contract). */
  readonly metric?: ShellSnapshotMetric
  /** Injected clock — defaults to `Date.now`. Only consulted when `metric`
   *  is wired. */
  readonly now?: () => number
}

/** Default production port. Uses real `Bun.spawn` via the supplied
 *  spawner — caller injects so the port stays testable.
 *
 *  Back-compat: the second positional argument used to be `home: string`.
 *  That form is still accepted (the string is treated as `{ home }`); new
 *  callers SHOULD pass {@link CreateShellSnapshotPortOpts} so they can
 *  also wire the optional metric port (ADR-0222). */
export const createShellSnapshotPort = (
  spawner: SnapshotSpawner,
  homeOrOpts?: string | CreateShellSnapshotPortOpts,
): ShellSnapshotPort => {
  const opts: CreateShellSnapshotPortOpts =
    typeof homeOrOpts === "string" ? { home: homeOrOpts } : (homeOrOpts ?? {})
  const home = opts.home ?? homedir()
  const metric = opts.metric
  const now = opts.now ?? Date.now
  return {
    async capture(captureOpts: CaptureOptions): Promise<Result<SnapshotHandle, SnapErr>> {
      const captureFn = captureOpts.shell === "zsh" ? captureZsh : captureBash
      const startedAt = metric !== undefined ? now() : 0
      const result = await captureFn(spawner, {
        ...(captureOpts.id !== undefined ? { seed: captureOpts.id } : {}),
        home,
      })
      // ADR-0222 — record duration + byte size on success only. The metric
      // port is no-throw per its contract; defense-in-depth `try` so a
      // recorder bug never aborts capture. `statSync` is best-effort — a
      // vanished file (concurrent prune) degrades silently to `bytes = 0`.
      if (metric !== undefined && result.ok) {
        let bytes = 0
        try {
          bytes = statSync(result.value.path).size
        } catch {
          // file vanished or unreadable — emit duration with bytes=0
        }
        try {
          metric.recordCapture(now() - startedAt, bytes)
        } catch {
          // intentional swallow — metric must not break capture
        }
      }
      return result
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
  }
}
